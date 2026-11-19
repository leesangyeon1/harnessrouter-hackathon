"""Sign-in, open customer guest sessions, local admin credentials, and roles (D25).

Supports:
- Identity Platform RS256 ID tokens (verified against Google JWKS; roles read from `user_roles`).
- Server-minted HS256 customer guest tokens (`POST /v1/auth/guest`) so any visitor on the customer
  webpage gets an isolated tenant `user_id` (`guest_<uuid>`) without a sign-in wall.
- Server-minted HS256 operations admin tokens (`POST /v1/auth/admin-login`) authenticated via the
  configured Admin ID & Password (`ID: admin`).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from collections.abc import Callable
from typing import Annotated, Any
from uuid import uuid4

import jwt
from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, ConfigDict, Field

from finance_api.db import tenant_transaction

# The public keys Identity Platform signs ID tokens with.
JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
)

LOCAL_SESSION_KID = "local-hs256-v1"
_DEFAULT_ADMIN_ID = "admin"
_DEFAULT_ADMIN_SALT = b"hr-admin-salt-v1"
_DEFAULT_ADMIN_DIGEST = "e8bdcf26e85231e198f8305b8f9791647c39726b48eff8f04dac91c9f590cd7a"
_PBKDF2_ITERATIONS = 200_000


class InvalidTokenError(Exception):
    """The token is not a valid ID or session token of this project."""


def derive_session_signing_key(seed: bytes) -> bytes:
    """Derive a dedicated 32-byte HMAC-SHA256 signing key for local session JWTs."""
    return hashlib.sha256(b"harness-session-hs256-v1:" + seed).digest()


def _local_issuer(project_id: str) -> str:
    return f"urn:harness-finance:{project_id}"


def verify_admin_credentials(username: str, candidate_secret: str) -> bool:
    """Constant-time verification of Operations Admin ID and password."""
    expected_id = os.environ.get("ADMIN_LOGIN_ID", _DEFAULT_ADMIN_ID).strip()
    id_ok = hmac.compare_digest(username.strip(), expected_id)

    configured_secret = os.environ.get("ADMIN_LOGIN_PASSWORD", "")
    if configured_secret:
        secret_ok = hmac.compare_digest(
            candidate_secret.encode("utf-8"),
            configured_secret.encode("utf-8"),
        )
    else:
        derived = hashlib.pbkdf2_hmac(
            "sha256",
            candidate_secret.encode("utf-8"),
            _DEFAULT_ADMIN_SALT,
            _PBKDF2_ITERATIONS,
        ).hex()
        secret_ok = hmac.compare_digest(derived, _DEFAULT_ADMIN_DIGEST)

    return id_ok and secret_ok


def mint_guest_token(
    *,
    signing_key: bytes,
    project_id: str,
    previous_token: str | None = None,
    ttl_seconds: int = 7 * 86400,
) -> dict[str, Any]:
    """Mint or renew a signed customer guest token preserving tenant isolation per visitor."""
    guest_uid: str | None = None
    if previous_token:
        try:
            header = jwt.get_unverified_header(previous_token)
            if header.get("alg") == "HS256" and header.get("kid") == LOCAL_SESSION_KID:
                prev_claims = jwt.decode(
                    previous_token,
                    signing_key,
                    algorithms=["HS256"],
                    audience=project_id,
                    issuer=_local_issuer(project_id),
                    options={"verify_exp": False, "require": ["iat", "sub", "session_kind"]},
                )
                prev_sub = prev_claims.get("sub")
                if (
                    prev_claims.get("session_kind") == "guest"
                    and isinstance(prev_sub, str)
                    and prev_sub.startswith("guest_")
                    and len(prev_sub) <= 64
                ):
                    guest_uid = prev_sub
        except jwt.PyJWTError:
            guest_uid = None

    if guest_uid is None:
        guest_uid = f"guest_{uuid4().hex}"

    now = int(time.time())
    exp = now + ttl_seconds
    encoded = jwt.encode(
        {
            "sub": guest_uid,
            "session_kind": "guest",
            "iss": _local_issuer(project_id),
            "aud": project_id,
            "iat": now,
            "exp": exp,
        },
        signing_key,
        algorithm="HS256",
        headers={"kid": LOCAL_SESSION_KID, "typ": "JWT"},
    )
    return {
        "token": encoded,
        "user_id": guest_uid,
        "role": "user",
        "expires_at": exp,
    }


def mint_admin_token(
    *,
    signing_key: bytes,
    project_id: str,
    ttl_seconds: int = 8 * 3600,
) -> dict[str, Any]:
    """Mint a signed HS256 administrator session token after credential verification."""
    now = int(time.time())
    exp = now + ttl_seconds
    encoded = jwt.encode(
        {
            "sub": "ops-admin",
            "session_kind": "local_admin",
            "iss": _local_issuer(project_id),
            "aud": project_id,
            "iat": now,
            "exp": exp,
        },
        signing_key,
        algorithm="HS256",
        headers={"kid": LOCAL_SESSION_KID, "typ": "JWT"},
    )
    return {
        "token": encoded,
        "user_id": "ops-admin",
        "role": "admin",
        "expires_at": exp,
    }


def verify_local_session_token(
    token: str,
    *,
    signing_key: bytes,
    project_id: str,
) -> tuple[str, str]:
    """Verify a server-minted HS256 token and return `(uid, session_kind)`."""
    try:
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["HS256"],
            audience=project_id,
            issuer=_local_issuer(project_id),
            options={"require": ["exp", "iat", "sub", "session_kind"]},
        )
    except jwt.PyJWTError as err:
        raise InvalidTokenError(str(err)) from err

    uid = claims.get("sub")
    kind = claims.get("session_kind")
    if not isinstance(uid, str) or not uid or kind not in ("guest", "local_admin"):
        raise InvalidTokenError("invalid local session claims")
    return uid, str(kind)


class IdTokenVerifier:
    def __init__(self, project_id: str, signing_key: Callable[[str], jwt.PyJWK]) -> None:
        self._project_id = project_id
        self._signing_key = signing_key

    @property
    def project_id(self) -> str:
        return self._project_id

    @property
    def signing_key(self) -> Callable[[str], jwt.PyJWK]:
        return self._signing_key

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


def _is_local_hs256_token(raw_token: str) -> bool:
    try:
        hdr = jwt.get_unverified_header(raw_token)
    except jwt.PyJWTError:
        return False
    return hdr.get("alg") == "HS256" and hdr.get("kid") == LOCAL_SESSION_KID


def current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> str:
    """The uid of the caller. Accepts verified RS256 ID tokens or server-minted HS256 sessions."""
    verifier: IdTokenVerifier = request.app.state.verifier
    local_key: bytes | None = getattr(request.app.state, "auth_signing_key", None)
    try:
        if credentials is None:
            raise InvalidTokenError("no bearer token")
        raw = credentials.credentials
        if local_key is not None and _is_local_hs256_token(raw):
            uid, session_kind = verify_local_session_token(
                raw,
                signing_key=local_key,
                project_id=verifier.project_id,
            )
            request.state.session_kind = session_kind
            return uid
        request.state.session_kind = "firebase"
        return verifier.verify(raw)
    except InvalidTokenError as error:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "sign-in required", {"WWW-Authenticate": "Bearer"}
        ) from error


def current_role(request: Request, user_id: Annotated[str, Depends(current_user)]) -> str:
    """The caller's role: `'admin'` for verified local admin login, `'user'` for guests, or DB."""
    session_kind = getattr(request.state, "session_kind", "firebase")
    if session_kind == "local_admin":
        return "admin"
    if session_kind == "guest":
        return "user"
    pool: ConnectionPool = request.app.state.pool
    with tenant_transaction(pool, user_id) as conn:
        row = conn.execute("SELECT role FROM user_roles WHERE user_id = %s", (user_id,)).fetchone()
    role: str = "user" if row is None else row[0]
    return role


def require_admin(role: Annotated[str, Depends(current_role)]) -> None:
    if role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin role required")


class GuestSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    previous_token: str | None = Field(default=None, max_length=4096)


class AdminLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


def create_public_auth_app(signing_key: bytes, project_id: str) -> FastAPI:
    """Public session bootstrap app mounted at `/v1/auth` outside `Depends(current_user)`."""
    auth_app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @auth_app.post("/guest")
    def issue_guest_session(
        response: Response,
        payload: Annotated[GuestSessionRequest | None, Body()] = None,
    ) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store, private"
        prev = payload.previous_token if payload is not None else None
        return mint_guest_token(
            signing_key=signing_key,
            project_id=project_id,
            previous_token=prev,
        )

    @auth_app.post("/admin-login")
    def admin_login(payload: AdminLoginRequest, response: Response) -> dict[str, Any]:
        response.headers["Cache-Control"] = "no-store, private"
        if not verify_admin_credentials(payload.username, payload.password):
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "Invalid administrator ID or password.",
                {"WWW-Authenticate": "Bearer"},
            )
        return mint_admin_token(signing_key=signing_key, project_id=project_id)

    return auth_app
