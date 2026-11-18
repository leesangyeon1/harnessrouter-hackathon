"""The API service. Run with: uvicorn finance_api.app:app_from_env --factory"""

import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID, uuid4

import jwt
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from psycopg_pool import ConnectionPool

from finance_api import plaid_ingest, reports
from finance_api.auth import JWKS_URL, IdTokenVerifier, current_role, current_user, require_admin
from finance_api.plaid import PlaidClient, PlaidError, plaid_client_from_env
from finance_api.sealing import SecretBox
from finance_api.worker_api import create_worker_app, hash_token


def create_app(
    pool: ConnectionPool, verifier: IdTokenVerifier, plaid: PlaidClient, box: SecretBox
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        pool.open()
        try:
            yield
        finally:
            pool.close()

    # Every route requires a valid ID token. The generated docs routes would not, so there are none.
    # The worker API is mounted apart, because it takes a worker token and never an ID token.
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
    app.include_router(plaid_ingest.router)
    app.include_router(reports.router)

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

    app.mount("/worker/v1", create_worker_app(pool))
    return app


def app_from_env() -> FastAPI:
    pool = ConnectionPool(os.environ["DATABASE_URL"], open=False)
    keys = jwt.PyJWKClient(JWKS_URL)
    verifier = IdTokenVerifier(os.environ["IDENTITY_PROJECT_ID"], keys.get_signing_key_from_jwt)
    box = SecretBox(os.environ["SECRET_BOX_KEY"])
    return create_app(pool, verifier, plaid_client_from_env(), box)
