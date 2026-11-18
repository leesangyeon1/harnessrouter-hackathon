"""Sign-in and roles (D25).

The caller is whoever the Identity Platform ID token names. The role is read from
PostgreSQL on every request, so removing it takes effect without a new sign-in.
"""

from collections.abc import Callable
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg_pool import ConnectionPool

from finance_api.db import tenant_transaction

# The public keys Identity Platform signs ID tokens with.
JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
)


class InvalidTokenError(Exception):
    """The token is not a valid ID token of this project."""


class IdTokenVerifier:
    def __init__(self, project_id: str, signing_key: Callable[[str], jwt.PyJWK]) -> None:
        self._project_id = project_id
        self._signing_key = signing_key

    def verify(self, token: str) -> str:
        """Return the uid the token was issued to."""
        try:
            claims = jwt.decode(
                token,
                self._signing_key(token),
                algorithms=["RS256"],
                audience=self._project_id,
                issuer=f"https://securetoken.google.com/{self._project_id}",
                options={"require": ["exp", "iat", "sub"]},
            )
        except jwt.PyJWKClientConnectionError:
            # The key service failing says nothing about the token.
            raise
        except jwt.PyJWTError as error:
            raise InvalidTokenError(str(error)) from error
        uid = claims["sub"]
        if not isinstance(uid, str) or not uid:
            raise InvalidTokenError("the token has no subject")
        return uid


_bearer = HTTPBearer(auto_error=False)


def current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> str:
    """The uid of the signed-in caller. Refuses the request without a valid ID token."""
    verifier: IdTokenVerifier = request.app.state.verifier
    try:
        if credentials is None:
            raise InvalidTokenError("no bearer token")
        return verifier.verify(credentials.credentials)
    except InvalidTokenError as error:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "sign-in required", {"WWW-Authenticate": "Bearer"}
        ) from error


def current_role(request: Request, user_id: Annotated[str, Depends(current_user)]) -> str:
    """The caller's role as the database holds it now."""
    pool: ConnectionPool = request.app.state.pool
    with tenant_transaction(pool, user_id) as conn:
        row = conn.execute("SELECT role FROM user_roles WHERE user_id = %s", (user_id,)).fetchone()
    role: str = "user" if row is None else row[0]
    return role


def require_admin(role: Annotated[str, Depends(current_role)]) -> None:
    if role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin role required")
