"""The API service. Run with: uvicorn finance_api.app:app_from_env --factory"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import jwt
from fastapi import Depends, FastAPI
from psycopg_pool import ConnectionPool

from finance_api.auth import JWKS_URL, IdTokenVerifier, current_role, current_user


def create_app(pool: ConnectionPool, verifier: IdTokenVerifier) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        pool.open()
        try:
            yield
        finally:
            pool.close()

    # Every route requires a valid ID token. The generated docs routes would not, so there are none.
    app = FastAPI(
        lifespan=lifespan,
        dependencies=[Depends(current_user)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.pool = pool
    app.state.verifier = verifier

    @app.get("/v1/me")
    def me(
        user_id: Annotated[str, Depends(current_user)],
        role: Annotated[str, Depends(current_role)],
    ) -> dict[str, str]:
        return {"user_id": user_id, "role": role}

    return app


def app_from_env() -> FastAPI:
    pool = ConnectionPool(os.environ["DATABASE_URL"], open=False)
    keys = jwt.PyJWKClient(JWKS_URL)
    verifier = IdTokenVerifier(os.environ["IDENTITY_PROJECT_ID"], keys.get_signing_key_from_jwt)
    return create_app(pool, verifier)
