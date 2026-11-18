"""Private Cloud Run worker service for Cloud Tasks async HarnessRouter execution.

Run with: uvicorn finance_api.task_worker:worker_app_from_env --factory
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Annotated, Any
from uuid import UUID

import jwt
from fastapi import Depends, FastAPI, HTTPException, status
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, ConfigDict

from finance_api.db import create_pool, tenant_transaction
from finance_api.health import create_health_app
from finance_api.internal_auth import (
    GOOGLE_OIDC_JWKS_URL,
    ServiceOidcVerifier,
    require_service_caller,
)
from finance_api.observability import (
    CorrelationMiddleware,
    configure_cloud_logging,
    cycle_id_var,
    register_secret_for_redaction,
    task_id_var,
)

logger = logging.getLogger(__name__)

TERMINAL_TASK_STATUSES = frozenset({"completed", "succeeded", "failed", "canceled"})


class TaskDispatchPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    task_id: UUID
    idempotency_key: str


TaskRunner = Callable[[ConnectionPool, TaskDispatchPayload, dict[str, Any]], str]


def _unimplemented_runner(
    _pool: ConnectionPool, _payload: TaskDispatchPayload, _row: dict[str, Any]
) -> str:
    raise HTTPException(
        status.HTTP_501_NOT_IMPLEMENTED,
        "HarnessRouter task runner module is not yet registered",
    )


def create_task_worker_app(
    pool: ConnectionPool,
    service_verifier: ServiceOidcVerifier,
    runner: TaskRunner = _unimplemented_runner,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        pool.open()
        try:
            yield
        finally:
            pool.close()

    app = FastAPI(
        lifespan=lifespan,
        dependencies=[Depends(require_service_caller)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.pool = pool
    app.state.service_verifier = service_verifier
    app.add_middleware(CorrelationMiddleware)
    app.mount("/health", create_health_app(pool, required_role="finance_api"))

    @app.post("/internal/tasks/harness")
    def dispatch_harness_task(
        payload: TaskDispatchPayload,
        caller_sa: Annotated[str, Depends(require_service_caller)],
    ) -> dict[str, str]:
        """Idempotently claim and run an agent_tasks row for one tenant."""
        t_tok = task_id_var.set(str(payload.task_id))
        c_tok = None
        try:
            with tenant_transaction(pool, payload.user_id) as conn:
                row = conn.execute(
                    "SELECT id, kind, idempotency_key, cost_cap_usd, timeout_seconds,"
                    " status, cycle_id"
                    " FROM agent_tasks WHERE id = %s FOR UPDATE",
                    (payload.task_id,),
                ).fetchone()
                if row is None:
                    raise HTTPException(status.HTTP_404_NOT_FOUND, "agent task not found")
                (
                    db_id,
                    kind,
                    stored_idem_key,
                    cost_cap_usd,
                    timeout_seconds,
                    current_status,
                    cycle_id,
                ) = row
                if cycle_id is not None:
                    c_tok = cycle_id_var.set(str(cycle_id))
                if stored_idem_key != payload.idempotency_key:
                    raise HTTPException(
                        status.HTTP_409_CONFLICT, "idempotency_key does not match stored task"
                    )
                if current_status in TERMINAL_TASK_STATUSES:
                    logger.info(
                        "Skipping duplicate delivery for terminal agent_task %s (%s)",
                        db_id,
                        current_status,
                    )
                    return {"task_id": str(db_id), "status": "already_processed"}
                if Decimal(cost_cap_usd) <= 0 or int(timeout_seconds) <= 0:
                    raise HTTPException(
                        status.HTTP_422_UNPROCESSABLE_CONTENT,
                        "agent_task lacks positive cost cap or timeout",
                    )
                if current_status == "running":
                    logger.info("Task %s is already running", db_id)
                    return {"task_id": str(db_id), "status": "already_running"}
                conn.execute(
                    "UPDATE agent_tasks SET status = 'running' WHERE id = %s",
                    (db_id,),
                )

            task_meta: dict[str, Any] = {
                "kind": kind,
                "cost_cap_usd": Decimal(cost_cap_usd),
                "timeout_seconds": int(timeout_seconds),
                "cycle_id": None if cycle_id is None else str(cycle_id),
                "caller_sa": caller_sa,
            }
            result_text = runner(pool, payload, task_meta)

            with tenant_transaction(pool, payload.user_id) as conn:
                conn.execute(
                    "UPDATE agent_tasks SET status = 'completed', result_text = %s WHERE id = %s",
                    (result_text, payload.task_id),
                )
            logger.info("Completed agent_task %s", payload.task_id)
            return {"task_id": str(payload.task_id), "status": "completed"}
        finally:
            if c_tok is not None:
                cycle_id_var.reset(c_tok)
            task_id_var.reset(t_tok)

    return app


def worker_app_from_env() -> FastAPI:
    configure_cloud_logging()
    register_secret_for_redaction(
        os.environ.get("DATABASE_URL"),
        os.environ.get("HARNESSROUTER_API_KEY"),
        os.environ.get("SECRET_BOX_KEY"),
    )
    pool = create_pool(os.environ["DATABASE_URL"], open_pool=False)
    keys = jwt.PyJWKClient(GOOGLE_OIDC_JWKS_URL)
    allowed_sas = os.environ["TASKS_INVOKER_SA_EMAIL"].split(",")
    verifier = ServiceOidcVerifier(
        audience=os.environ["WORKER_SERVICE_URL"],
        allowed_emails=allowed_sas,
        signing_key=keys.get_signing_key_from_jwt,
    )
    return create_task_worker_app(pool, verifier)
