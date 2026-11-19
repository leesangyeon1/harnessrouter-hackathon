"""Cloud Run liveness and readiness probes.

Mounted under /health so probes never weaken the ID-token dependency on /v1/*.
"""

from __future__ import annotations

import logging

import psycopg
from fastapi import FastAPI, status
from fastapi.responses import JSONResponse
from psycopg_pool import ConnectionPool, PoolTimeout

from finance_api.db import verify_runtime_role

logger = logging.getLogger(__name__)

_REQUIRED_TABLES = ("user_roles", "plaid_items", "reports", "worker_tokens", "agent_tasks")


def check_readiness(pool: ConnectionPool, required_role: str = "finance_api") -> tuple[bool, str]:
    """Verify DB connectivity, schema presence, and non-privileged runtime role."""
    try:
        with pool.connection(timeout=3.0) as conn:
            conn.execute("SELECT 1")
            role_issue = verify_runtime_role(conn, required_role=required_role)
            if role_issue is not None:
                return False, f"unsafe_db_role:{role_issue}"
            for table in _REQUIRED_TABLES:
                present = conn.execute(
                    "SELECT to_regclass(%s) IS NOT NULL", (f"public.{table}",)
                ).fetchone()
                if present is None or not present[0]:
                    return False, "schema_incomplete"
    except (psycopg.Error, PoolTimeout, OSError) as exc:
        logger.error("Readiness database check failed: %s", exc.__class__.__name__)
        return False, "database_unavailable"
    return True, "ok"


def create_health_app(pool: ConnectionPool, required_role: str = "finance_api") -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/live")
    def live() -> dict[str, str]:
        return {"status": "live"}

    @app.get("/ready", response_model=None)
    def ready() -> JSONResponse:
        ok, detail = check_readiness(pool, required_role=required_role)
        if not ok:
            return JSONResponse(
                {"status": "not_ready", "reason": detail},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return JSONResponse({"status": "ready"}, status_code=status.HTTP_200_OK)

    return app
