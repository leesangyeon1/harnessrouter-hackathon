"""Service-to-service Google OIDC verification for private Cloud Run endpoints.

Strictly separated from browser Identity Platform tokens (auth.py) and
CPU-node worker tokens (worker_api.py).
"""

from __future__ import annotations

from collections.abc import Callable, Collection
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
_GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")


class InvalidServiceTokenError(Exception):
    """The bearer token is not a valid Google OIDC service token."""


class UnauthorizedServiceCallerError(Exception):
    """The Google OIDC token belongs to a principal not permitted to invoke this service."""


class ServiceOidcVerifier:
    def __init__(
        self,
        audience: str,
        allowed_emails: Collection[str],
        signing_key: Callable[[str], jwt.PyJWK],
    ) -> None:
        if not audience.startswith(("https://", "http://127.0.0.1", "http://localhost")):
            raise ValueError("service OIDC audience must be an HTTPS URL (or loopback in tests)")
        cleaned_emails = frozenset(email.strip() for email in allowed_emails if email.strip())
        if not cleaned_emails:
            raise ValueError("at least one allowed service account email is required")
        self._audience = audience
        self._allowed_emails = cleaned_emails
        self._signing_key = signing_key

    def verify(self, token: str) -> str:
        """Verify Google OIDC token and return the authorized service account email."""
        try:
            claims = jwt.decode(
                token,
                self._signing_key(token),
                algorithms=["RS256"],
                audience=self._audience,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
        except jwt.PyJWKClientConnectionError:
            raise
        except jwt.PyJWTError as error:
            raise InvalidServiceTokenError(str(error)) from error

        issuer = claims.get("iss")
        if issuer not in _GOOGLE_ISSUERS:
            raise InvalidServiceTokenError("unexpected token issuer")

        email = claims.get("email")
        email_verified = claims.get("email_verified")
        if not isinstance(email, str) or not email or email_verified is not True:
            raise InvalidServiceTokenError("unverified service account email claim")

        if email not in self._allowed_emails:
            raise UnauthorizedServiceCallerError(email)

        return email


_bearer = HTTPBearer(auto_error=False)


def require_service_caller(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> str:
    """Require a Google OIDC token from an explicitly authorized service account."""
    verifier: ServiceOidcVerifier = request.app.state.service_verifier
    if credentials is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "service OIDC token required",
            {"WWW-Authenticate": "Bearer"},
        )
    try:
        return verifier.verify(credentials.credentials)
    except InvalidServiceTokenError as error:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "invalid service OIDC token",
            {"WWW-Authenticate": "Bearer"},
        ) from error
    except UnauthorizedServiceCallerError as error:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "service account not authorized",
        ) from error
