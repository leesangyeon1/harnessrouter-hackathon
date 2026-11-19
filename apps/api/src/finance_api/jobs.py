"""Cloud Run Jobs entrypoint for scheduled and long-running background jobs.

Usage:
  python -m finance_api.jobs market-ingest
  python -m finance_api.jobs paper-order
  python -m finance_api.jobs agent-task
"""

from __future__ import annotations

import importlib
import logging
import os
import sys
from collections.abc import Callable
from uuid import uuid4

import psycopg

from finance_api.db import verify_runtime_role
from finance_api.observability import (
    configure_cloud_logging,
    cycle_id_var,
    register_secret_for_redaction,
    request_id_var,
    task_id_var,
)
from finance_api.plaid import SANDBOX_HOST

logger = logging.getLogger(__name__)

ALPACA_PAPER_URL = "https://paper-api.alpaca.markets"

_JOB_SPECS: dict[str, tuple[str, str]] = {
    "market-ingest": ("finance_cycle", "finance_api.market_ingest"),
    "paper-order": ("finance_executor", "finance_api.paper_order"),
    "agent-task": ("finance_api", "finance_api.agent_job"),
}


def validate_sandbox_and_paper_env() -> None:
    """Refuse live brokerage or non-Sandbox Plaid hosts before any job runs."""
    alpaca_url = os.environ.get("ALPACA_PAPER_BASE_URL", ALPACA_PAPER_URL).rstrip("/")
    if alpaca_url != ALPACA_PAPER_URL:
        raise ValueError(
            f"ALPACA_PAPER_BASE_URL names {alpaca_url}; only {ALPACA_PAPER_URL} may be used"
        )
    if os.environ.get("ALPACA_LIVE_ENABLED", "").lower() in ("1", "true", "yes"):
        raise ValueError("live trading is prohibited; only Alpaca paper trading is permitted")
    plaid_host = os.environ.get("PLAID_HOST", SANDBOX_HOST)
    if plaid_host != SANDBOX_HOST:
        raise ValueError(f"PLAID_HOST names {plaid_host}; only {SANDBOX_HOST} may be used")


def run_job(
    job_name: str,
    database_url: str,
    *,
    entrypoint_override: Callable[[psycopg.Connection], str | None] | None = None,
) -> None:
    """Validate environment and runtime DB role, then execute one Cloud Run Job."""
    if job_name not in _JOB_SPECS:
        raise ValueError(f"unknown job {job_name!r}; expected one of {sorted(_JOB_SPECS)}")

    validate_sandbox_and_paper_env()
    required_role, module_name = _JOB_SPECS[job_name]

    execution_id = os.environ.get("CLOUD_RUN_EXECUTION") or f"job-{uuid4().hex[:12]}"
    task_id = os.environ.get("TASK_ID") or os.environ.get("CLOUD_RUN_TASK_INDEX")
    initial_cycle_id = os.environ.get("CYCLE_ID")

    req_tok = request_id_var.set(execution_id)
    task_tok = task_id_var.set(task_id)
    cycle_tok = cycle_id_var.set(initial_cycle_id)

    try:
        logger.info("Starting job %s", job_name, extra={"job_name": job_name})
        with psycopg.connect(database_url) as conn:
            role_issue = verify_runtime_role(conn, required_role=required_role)
            if role_issue is not None:
                raise RuntimeError(
                    f"refusing to run {job_name} with unsafe database role ({role_issue})"
                )

            if entrypoint_override is not None:
                produced_cycle = entrypoint_override(conn)
            else:
                try:
                    module = importlib.import_module(module_name)
                except ModuleNotFoundError as exc:
                    raise RuntimeError(
                        f"job domain module {module_name} is not yet present on this branch"
                    ) from exc
                runner: Callable[[psycopg.Connection], str | None] = module.run_job
                produced_cycle = runner(conn)

            if produced_cycle:
                cycle_id_var.set(produced_cycle)
            logger.info("Completed job %s", job_name, extra={"job_name": job_name})
    except Exception:
        logger.exception("Job %s failed", job_name, extra={"job_name": job_name})
        raise
    finally:
        cycle_id_var.reset(cycle_tok)
        task_id_var.reset(task_tok)
        request_id_var.reset(req_tok)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in _JOB_SPECS:
        sys.stderr.write(f"Usage: python -m finance_api.jobs <{'|'.join(_JOB_SPECS)}>\n")
        return 2

    configure_cloud_logging()
    register_secret_for_redaction(
        os.environ.get("DATABASE_URL"),
        os.environ.get("ALPACA_API_KEY"),
        os.environ.get("ALPACA_SECRET_KEY"),
        os.environ.get("PLAID_SECRET"),
        os.environ.get("SECRET_BOX_KEY"),
        os.environ.get("HARNESSROUTER_API_KEY"),
        os.environ.get("TOKENROUTER_API_KEY"),
    )
    run_job(args[0], os.environ["DATABASE_URL"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
