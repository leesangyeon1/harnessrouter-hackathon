"""The API service. Run with: uvicorn finance_api.app:app_from_env --factory"""

import os
import secrets
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import Annotated
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
import jwt
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg_pool import ConnectionPool

from finance_api import admin_performance, agent_search, cycles, plaid_ingest, reports
from finance_api.auth import (
    JWKS_URL,
    IdTokenVerifier,
    create_public_auth_app,
    current_role,
    current_user,
    derive_session_signing_key,
    require_admin,
)
from finance_api.db import create_pool
from finance_api.harnessrouter_adapter import HarnessRouter, load_api_key, preview_secret
from finance_api.health import create_health_app
from finance_api.observability import (
    CorrelationMiddleware,
    configure_cloud_logging,
    register_secret_for_redaction,
)
from finance_api.plaid import PlaidClient, PlaidError, plaid_client_from_env
from finance_api.sealing import SecretBox
from finance_api.secret_console import RootPortalMiddleware, build_default_secret_console
from finance_api.worker_api import create_worker_app, hash_token


def _validate_cors_origins(origins: Sequence[str]) -> list[str]:
    validated: list[str] = []
    for raw in origins:
        origin = raw.strip().rstrip("/")
        if not origin:
            continue
        if origin == "*":
            raise ValueError("wildcard CORS origin '*' is not permitted")
        parsed = urlsplit(origin)
        is_loopback = parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")
        if parsed.scheme != "https" and not is_loopback:
            raise ValueError(f"CORS origin {origin!r} must use HTTPS")
        if not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
            raise ValueError(f"CORS origin {origin!r} must be scheme://host[:port] only")
        validated.append(origin)
    return validated


def create_app(
    pool: ConnectionPool,
    verifier: IdTokenVerifier,
    plaid: PlaidClient,
    box: SecretBox,
    *,
    cors_origins: Sequence[str] = (),
    secret_console: FastAPI | None = None,
    harness_router: HarnessRouter | None = None,
    preview_signing_key: bytes | None = None,
) -> FastAPI:
    allowed_origins = _validate_cors_origins(cors_origins)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        pool.open()
        try:
            yield
        finally:
            pool.close()

    # Every route requires a valid ID token. The generated docs routes would not, so there are none.
    # Worker and health routes are mounted apart so /v1/* keeps strict ID-token enforcement.
    app = FastAPI(
        lifespan=lifespan,
        dependencies=[Depends(current_user)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.pool = pool
    app.state.verifier = verifier
    app.state.plaid = plaid
    app.state.box = box
    app.state.harness_router = harness_router
    p_key = preview_signing_key or preview_secret()
    app.state.preview_signing_key = p_key
    auth_key = derive_session_signing_key(p_key)
    app.state.auth_signing_key = auth_key

    def _swap_plaid(new_client_id: str, new_secret: str) -> None:
        app.state.plaid = PlaidClient(new_client_id, new_secret, httpx.Client(timeout=30))

    def _swap_hr(new_hr_key: str) -> None:
        register_secret_for_redaction(new_hr_key)
        app.state.harness_router = HarnessRouter(api_key=new_hr_key)

    console_app = secret_console or build_default_secret_console(
        verifier.project_id,
        verifier.signing_key,
        on_plaid_credentials_updated=_swap_plaid,
        on_harnessrouter_key_updated=_swap_hr,
    )
    app.add_middleware(RootPortalMiddleware, console_app=console_app)
    app.add_middleware(CorrelationMiddleware)
    if allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=allowed_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-Idempotency-Key"],
            expose_headers=["X-Request-ID"],
        )
    app.include_router(plaid_ingest.router)
    app.include_router(reports.router)
    app.include_router(cycles.router)
    app.include_router(admin_performance.router)
    app.include_router(agent_search.router)

    @app.exception_handler(PlaidError)
    def plaid_refused(_: Request, error: PlaidError) -> JSONResponse:
        return JSONResponse(
            {"detail": f"Plaid refused the request ({error.code})"},
            status_code=status.HTTP_502_BAD_GATEWAY,
        )

    @app.get("/v1/me")
    def me(
        user_id: Annotated[str, Depends(current_user)],
        role: Annotated[str, Depends(current_role)],
    ) -> dict[str, str]:
        return {"user_id": user_id, "role": role}

    @app.post(
        "/v1/admin/worker-tokens",
        status_code=status.HTTP_201_CREATED,
        dependencies=[Depends(require_admin)],
    )
    def issue_worker_token() -> dict[str, str]:
        """A new worker token. This response is the only place it ever appears."""
        token_id, token = uuid4(), secrets.token_urlsafe(32)
        with pool.connection() as conn:
            conn.execute(
                "INSERT INTO worker_tokens (id, token_hash) VALUES (%s, %s)",
                (token_id, hash_token(token)),
            )
        return {"id": str(token_id), "token": token}

    @app.get("/v1/admin/worker-tokens", dependencies=[Depends(require_admin)])
    def list_worker_tokens() -> dict[str, list[dict[str, str | None]]]:
        with pool.connection() as conn:
            rows = conn.execute(
                "SELECT id, created_at, revoked_at FROM worker_tokens ORDER BY created_at DESC, id"
            ).fetchall()
        return {
            "tokens": [
                {
                    "id": str(token_id),
                    "created_at": created_at.isoformat(),
                    "revoked_at": None if revoked_at is None else revoked_at.isoformat(),
                }
                for token_id, created_at, revoked_at in rows
            ]
        }

    @app.delete(
        "/v1/admin/worker-tokens/{token_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        dependencies=[Depends(require_admin)],
    )
    def revoke_worker_token(token_id: UUID) -> None:
        with pool.connection() as conn:
            revoked = conn.execute(
                "UPDATE worker_tokens SET revoked_at = now()"
                " WHERE id = %s AND revoked_at IS NULL RETURNING id",
                (token_id,),
            ).fetchone()
        if revoked is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no live worker token has this id")

    app.mount("/health", create_health_app(pool))
    app.mount("/worker/v1", create_worker_app(pool))
    app.mount("/admin-secrets", console_app)
    app.mount("/v1/auth", create_public_auth_app(auth_key, verifier.project_id))
    app.mount(
        "/v1/agent-preview",
        agent_search.create_agent_preview_app(
            pool,
            box,
            p_key,
            lambda: getattr(app.state, "harness_router", None),
        ),
    )
    return app


def app_from_env() -> FastAPI:
    project_id = os.environ["IDENTITY_PROJECT_ID"]
    configure_cloud_logging(project_id)
    box_key_str = os.environ["SECRET_BOX_KEY"]
    register_secret_for_redaction(
        os.environ.get("DATABASE_URL"),
        os.environ.get("PLAID_SECRET"),
        box_key_str,
        os.environ.get("HR_API_KEY"),
        os.environ.get("HARNESSROUTER_API_KEY"),
    )
    pool = create_pool(os.environ["DATABASE_URL"], open_pool=False)
    keys = jwt.PyJWKClient(JWKS_URL)
    verifier = IdTokenVerifier(project_id, keys.get_signing_key_from_jwt)
    box = SecretBox(box_key_str)
    hr_client: HarnessRouter | None = None
    try:
        hr_key = load_api_key()
        register_secret_for_redaction(hr_key)
        hr_client = HarnessRouter(api_key=hr_key)
    except ValueError:
        hr_client = None
    raw_origins = os.environ.get("CORS_ALLOWED_ORIGINS", "")
    origins = [item for item in raw_origins.split(",") if item.strip()]
    return create_app(
        pool,
        verifier,
        plaid_client_from_env(),
        box,
        cors_origins=origins,
        harness_router=hr_client,
        preview_signing_key=preview_secret(box_key_str),
    )
