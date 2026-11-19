"""Owner-restricted API Gateway status & Secret Manager vault console.

Serves:
- Public status & Google Sign-In shell at `/` and `/admin-secrets/` (zero secret material exposed).
- Strictly authenticated Secret Manager API at `/admin-secrets/api/*` requiring a Google-verified
  ID token whose verified email is in `SECRET_ADMIN_ALLOWED_EMAILS` (default: `qcd2529@gmail.com`).
"""

from __future__ import annotations

import base64
import os
import time
from collections.abc import Callable, Collection
from dataclasses import dataclass
from importlib.resources import files
from typing import Annotated, Any, Protocol

import httpx
import jwt
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from starlette.types import ASGIApp, Receive, Scope, Send

from finance_api.internal_auth import GOOGLE_OIDC_JWKS_URL
from finance_api.observability import register_secret_for_redaction
from finance_api.plaid import SANDBOX_HOST, SANDBOX_INSTITUTION

DEFAULT_OWNER_EMAIL = "qcd2529@gmail.com"
UNCONFIGURED_MARKER = "unconfigured-replace-in-secret-manager"
_GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
_GCP_METADATA_ENDPOINT = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
)
_SM_API_BASE = "https://secretmanager.googleapis.com/v1"
_PORTAL_HTML = files("finance_api").joinpath("secret_console.html").read_text(encoding="utf-8")

_SECURITY_HEADERS: dict[str, str] = {
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
}


@dataclass(frozen=True)
class ManagedSecretSpec:
    key: str
    label: str
    env_name: str
    targets: str
    hint: str


MANAGED_SECRETS: tuple[ManagedSecretSpec, ...] = (
    ManagedSecretSpec(
        key="tokenrouter-api-key",
        label="TokenRouter API Key",
        env_name="TOKENROUTER_API_KEY",
        targets="Private Worker, Agent-Task Job",
        hint="Enter TokenRouter key",
    ),
    ManagedSecretSpec(
        key="harnessrouter-api-key",
        label="HarnessRouter API Key",
        env_name="HARNESSROUTER_API_KEY",
        targets="Private Worker, Agent-Task Job",
        hint="Enter HarnessRouter key",
    ),
    ManagedSecretSpec(
        key="plaid-client-id",
        label="Plaid Client ID",
        env_name="PLAID_CLIENT_ID",
        targets="FastAPI Service (Hot-reloaded)",
        hint="Enter Plaid Client ID",
    ),
    ManagedSecretSpec(
        key="plaid-secret",
        label="Plaid Sandbox Secret",
        env_name="PLAID_SECRET",
        targets="FastAPI Service (Hot-reloaded)",
        hint="Enter Plaid Sandbox secret",
    ),
    ManagedSecretSpec(
        key="alpaca-data-api-key",
        label="Alpaca Paper API Key ID",
        env_name="ALPACA_API_KEY",
        targets="Market-Ingest Job (paper-api & data)",
        hint="Enter Alpaca Paper Key ID",
    ),
    ManagedSecretSpec(
        key="alpaca-data-secret-key",
        label="Alpaca Paper Secret Key",
        env_name="ALPACA_SECRET_KEY",
        targets="Market-Ingest Job (paper-api & data)",
        hint="Enter Alpaca Paper Secret Key",
    ),
)

_SPEC_BY_KEY: dict[str, ManagedSecretSpec] = {spec.key: spec for spec in MANAGED_SECRETS}


def mask_secret_value(raw: str | None) -> tuple[bool, str]:
    """Return `(configured, masked_preview)` without exposing secret characters."""
    if not raw or raw == UNCONFIGURED_MARKER:
        return False, "(unconfigured placeholder)"
    register_secret_for_redaction(raw)
    if len(raw) <= 8:
        return True, "••••••••"
    return True, f"{raw[:4]}••••••••{raw[-4:]}"


class InvalidGoogleAuthError(Exception):
    """Token is missing, expired, or fails cryptographic signature/issuer/audience checks."""


class ForbiddenGoogleOwnerError(Exception):
    """Token is valid, but sign-in was not via Google or email is not the authorized owner."""


class GoogleOwnerVerifier:
    """Verify Google-authenticated JWTs strictly restricted to `allowed_emails`."""

    def __init__(
        self,
        identity_project_id: str,
        allowed_emails: Collection[str],
        identity_signing_key: Callable[[str], jwt.PyJWK],
        *,
        google_oauth_client_id: str = "",
        google_oidc_signing_key: Callable[[str], jwt.PyJWK] | None = None,
    ) -> None:
        cleaned = frozenset(e.strip().lower() for e in allowed_emails if e.strip())
        if not cleaned:
            raise ValueError("at least one allowed Google owner email is required")
        self._identity_project_id = identity_project_id
        self._allowed_emails = cleaned
        self._identity_signing_key = identity_signing_key
        self._google_oauth_client_id = google_oauth_client_id.strip()
        self._google_oidc_signing_key = google_oidc_signing_key

    @property
    def primary_owner_hint(self) -> str:
        return sorted(self._allowed_emails)[0]

    def verify(self, token: str) -> str:
        """Verify RS256 Google token and return the authorized owner email."""
        try:
            claims = self._verify_identity_platform_google(token)
        except InvalidGoogleAuthError:
            if not self._google_oauth_client_id or self._google_oidc_signing_key is None:
                raise
            claims = self._verify_direct_google_oidc(token)

        email = claims.get("email")
        email_verified = claims.get("email_verified")
        if not isinstance(email, str) or not email.strip() or email_verified is not True:
            raise ForbiddenGoogleOwnerError("verified Google account email is required")

        normalized = email.strip().lower()
        if normalized not in self._allowed_emails:
            raise ForbiddenGoogleOwnerError(f"Google account {normalized} is not authorized")
        return normalized

    def _verify_identity_platform_google(self, token: str) -> dict[str, Any]:
        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                self._identity_signing_key(token),
                algorithms=["RS256"],
                audience=self._identity_project_id,
                issuer=f"https://securetoken.google.com/{self._identity_project_id}",
                options={"require": ["exp", "iat", "sub", "aud", "iss"]},
            )
        except jwt.PyJWKClientConnectionError:
            raise
        except jwt.PyJWTError as error:
            raise InvalidGoogleAuthError(str(error)) from error

        fb_info = claims.get("firebase")
        provider = fb_info.get("sign_in_provider") if isinstance(fb_info, dict) else None
        if provider != "google.com":
            raise ForbiddenGoogleOwnerError("Sign in with Google is required for the secret vault")
        return claims

    def _verify_direct_google_oidc(self, token: str) -> dict[str, Any]:
        assert self._google_oidc_signing_key is not None  # noqa: S101
        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                self._google_oidc_signing_key(token),
                algorithms=["RS256"],
                audience=self._google_oauth_client_id,
                options={"require": ["exp", "iat", "sub", "aud", "iss"]},
            )
        except jwt.PyJWKClientConnectionError:
            raise
        except jwt.PyJWTError as error:
            raise InvalidGoogleAuthError(str(error)) from error

        if claims.get("iss") not in _GOOGLE_ISSUERS:
            raise InvalidGoogleAuthError("unexpected OIDC token issuer")
        return claims


@dataclass(frozen=True)
class SecretSummary:
    key: str
    secret_id: str
    label: str
    env_name: str
    targets: str
    hint: str
    configured: bool
    masked_preview: str
    version: str
    updated_at: str | None


@dataclass(frozen=True)
class SecretRevealed:
    key: str
    secret_id: str
    value: str
    configured: bool
    version: str


class SecretVaultBackend(Protocol):
    def list_secrets(self) -> list[SecretSummary]: ...

    def reveal_secret(self, key: str) -> SecretRevealed: ...

    def update_secret(self, key: str, new_value: str) -> SecretSummary: ...

    def get_raw_value(self, key: str) -> str | None: ...


class GcpSecretManagerBackend:
    """Access and rotate only the allowlisted provider secrets in GCP Secret Manager."""

    def __init__(
        self,
        project_id: str,
        name_prefix: str,
        http: httpx.Client | None = None,
    ) -> None:
        self._project_id = project_id
        self._name_prefix = name_prefix.rstrip("-")
        self._http = http or httpx.Client(timeout=15.0)
        self._cached_token: str | None = None
        self._token_expiry: float = 0.0

    def _secret_id(self, key: str) -> str:
        if key not in _SPEC_BY_KEY:
            raise KeyError(key)
        return f"{self._name_prefix}-{key}"

    def _access_token(self) -> str:
        now = time.monotonic()
        if self._cached_token and now < self._token_expiry:
            return self._cached_token
        resp = self._http.get(_GCP_METADATA_ENDPOINT, headers={"Metadata-Flavor": "Google"})
        if resp.status_code != 200:
            raise RuntimeError(f"Metadata token endpoint answered {resp.status_code}")
        data = resp.json()
        tok = str(data["access_token"])
        expires_in = int(data.get("expires_in", 300))
        self._cached_token = tok
        self._token_expiry = now + max(expires_in - 60, 10)
        return tok

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._access_token()}",
            "Content-Type": "application/json",
        }

    def _fetch_latest(self, spec: ManagedSecretSpec) -> tuple[str, str, str | None]:
        secret_id = self._secret_id(spec.key)
        meta_url = f"{_SM_API_BASE}/projects/{self._project_id}/secrets/{secret_id}/versions/latest"
        headers = self._headers()
        meta_resp = self._http.get(meta_url, headers=headers)
        if meta_resp.status_code == 404:
            return "", "none", None
        if meta_resp.status_code != 200:
            raise RuntimeError(
                f"Secret metadata lookup for {secret_id} returned {meta_resp.status_code}"
            )
        meta = meta_resp.json()
        ver_name = str(meta.get("name", "")).rsplit("/", 1)[-1] or "latest"
        created_at = meta.get("createTime")

        acc_resp = self._http.get(f"{meta_url}:access", headers=headers)
        if acc_resp.status_code != 200:
            raise RuntimeError(f"Secret access for {secret_id} returned {acc_resp.status_code}")
        b64_data = acc_resp.json().get("payload", {}).get("data", "")
        raw_val = base64.b64decode(b64_data).decode("utf-8", errors="replace") if b64_data else ""
        register_secret_for_redaction(raw_val)
        return raw_val, ver_name, str(created_at) if isinstance(created_at, str) else None

    def list_secrets(self) -> list[SecretSummary]:
        items: list[SecretSummary] = []
        for spec in MANAGED_SECRETS:
            raw_val, ver, updated_at = self._fetch_latest(spec)
            configured, masked = mask_secret_value(raw_val)
            items.append(
                SecretSummary(
                    key=spec.key,
                    secret_id=self._secret_id(spec.key),
                    label=spec.label,
                    env_name=spec.env_name,
                    targets=spec.targets,
                    hint=spec.hint,
                    configured=configured,
                    masked_preview=masked,
                    version=ver,
                    updated_at=updated_at,
                )
            )
        return items

    def reveal_secret(self, key: str) -> SecretRevealed:
        spec = _SPEC_BY_KEY[key]
        raw_val, ver, _ = self._fetch_latest(spec)
        configured, _ = mask_secret_value(raw_val)
        return SecretRevealed(
            key=spec.key,
            secret_id=self._secret_id(spec.key),
            value="" if not configured else raw_val,
            configured=configured,
            version=ver,
        )

    def update_secret(self, key: str, new_value: str) -> SecretSummary:
        spec = _SPEC_BY_KEY[key]
        secret_id = self._secret_id(spec.key)
        register_secret_for_redaction(new_value)
        encoded = base64.b64encode(new_value.encode("utf-8")).decode("ascii")
        add_url = f"{_SM_API_BASE}/projects/{self._project_id}/secrets/{secret_id}:addVersion"
        resp = self._http.post(
            add_url,
            headers=self._headers(),
            json={"payload": {"data": encoded}},
        )
        if resp.status_code not in (200, 201):
            raise RuntimeError(f"Secret version upload for {secret_id} returned {resp.status_code}")
        body = resp.json()
        ver_name = str(body.get("name", "")).rsplit("/", 1)[-1] or "latest"
        created_at = body.get("createTime")
        configured, masked = mask_secret_value(new_value)
        return SecretSummary(
            key=spec.key,
            secret_id=secret_id,
            label=spec.label,
            env_name=spec.env_name,
            targets=spec.targets,
            hint=spec.hint,
            configured=configured,
            masked_preview=masked,
            version=ver_name,
            updated_at=str(created_at) if isinstance(created_at, str) else None,
        )

    def get_raw_value(self, key: str) -> str | None:
        spec = _SPEC_BY_KEY.get(key)
        if spec is None:
            return None
        raw_val, _, _ = self._fetch_latest(spec)
        if not raw_val or raw_val == UNCONFIGURED_MARKER:
            return None
        return raw_val


class InMemorySecretBackend:
    """Offline backend used in local tests or when GCP metadata is absent."""

    def __init__(
        self,
        name_prefix: str = "hr-finance-dev",
        initial: dict[str, str] | None = None,
    ) -> None:
        self._prefix = name_prefix.rstrip("-")
        self._values: dict[str, str] = {
            spec.key: (initial or {}).get(spec.key, UNCONFIGURED_MARKER) for spec in MANAGED_SECRETS
        }
        self._versions: dict[str, int] = {spec.key: 1 for spec in MANAGED_SECRETS}

    def list_secrets(self) -> list[SecretSummary]:
        out: list[SecretSummary] = []
        for spec in MANAGED_SECRETS:
            raw = self._values.get(spec.key, UNCONFIGURED_MARKER)
            configured, masked = mask_secret_value(raw)
            out.append(
                SecretSummary(
                    key=spec.key,
                    secret_id=f"{self._prefix}-{spec.key}",
                    label=spec.label,
                    env_name=spec.env_name,
                    targets=spec.targets,
                    hint=spec.hint,
                    configured=configured,
                    masked_preview=masked,
                    version=str(self._versions[spec.key]),
                    updated_at=None,
                )
            )
        return out

    def reveal_secret(self, key: str) -> SecretRevealed:
        spec = _SPEC_BY_KEY[key]
        raw = self._values.get(spec.key, UNCONFIGURED_MARKER)
        configured, _ = mask_secret_value(raw)
        return SecretRevealed(
            key=spec.key,
            secret_id=f"{self._prefix}-{spec.key}",
            value="" if not configured else raw,
            configured=configured,
            version=str(self._versions[spec.key]),
        )

    def update_secret(self, key: str, new_value: str) -> SecretSummary:
        spec = _SPEC_BY_KEY[key]
        register_secret_for_redaction(new_value)
        self._values[spec.key] = new_value
        self._versions[spec.key] = self._versions.get(spec.key, 0) + 1
        configured, masked = mask_secret_value(new_value)
        return SecretSummary(
            key=spec.key,
            secret_id=f"{self._prefix}-{spec.key}",
            label=spec.label,
            env_name=spec.env_name,
            targets=spec.targets,
            hint=spec.hint,
            configured=configured,
            masked_preview=masked,
            version=str(self._versions[spec.key]),
            updated_at=None,
        )

    def get_raw_value(self, key: str) -> str | None:
        raw = self._values.get(key)
        if not raw or raw == UNCONFIGURED_MARKER:
            return None
        return raw


@dataclass(frozen=True)
class PortalPublicConfig:
    identity_project_id: str
    firebase_api_key: str = ""
    firebase_auth_domain: str = ""
    google_oauth_client_id: str = ""
    customer_web_url: str = ""
    admin_web_url: str = ""


class SecretUpdatePayload(BaseModel):
    value: str = Field(min_length=1, max_length=4096)


_bearer = HTTPBearer(auto_error=False)


def require_google_owner(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> str:
    """Require a Google-authenticated token belonging strictly to the configured owner email."""
    verifier: GoogleOwnerVerifier = request.app.state.owner_verifier
    if credentials is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Google sign-in required",
            {"WWW-Authenticate": "Bearer"},
        )
    try:
        return verifier.verify(credentials.credentials)
    except InvalidGoogleAuthError as error:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid or expired Google token",
            {"WWW-Authenticate": "Bearer"},
        ) from error
    except ForbiddenGoogleOwnerError as error:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            str(error),
        ) from error


def _summary_to_dict(item: SecretSummary) -> dict[str, Any]:
    return {
        "key": item.key,
        "secret_id": item.secret_id,
        "label": item.label,
        "env_name": item.env_name,
        "targets": item.targets,
        "hint": item.hint,
        "configured": item.configured,
        "masked_preview": item.masked_preview,
        "version": item.version,
        "updated_at": item.updated_at,
    }


def create_secret_console_app(
    owner_verifier: GoogleOwnerVerifier,
    vault: SecretVaultBackend,
    public_config: PortalPublicConfig,
    *,
    on_plaid_credentials_updated: Callable[[str, str], None] | None = None,
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.owner_verifier = owner_verifier
    app.state.vault = vault

    @app.middleware("http")
    async def attach_no_store_headers(
        request: Request, call_next: Callable[[Request], Any]
    ) -> Response:
        response: Response = await call_next(request)
        for header_name, header_val in _SECURITY_HEADERS.items():
            response.headers[header_name] = header_val
        return response

    @app.get("/", response_class=HTMLResponse)
    def portal_page() -> HTMLResponse:
        return HTMLResponse(_PORTAL_HTML)

    @app.get("/config")
    def portal_config() -> dict[str, str]:
        auth_domain = (
            public_config.firebase_auth_domain
            or f"{public_config.identity_project_id}.firebaseapp.com"
        )
        return {
            "identityProjectId": public_config.identity_project_id,
            "firebaseApiKey": public_config.firebase_api_key,
            "firebaseAuthDomain": auth_domain,
            "googleOAuthClientId": public_config.google_oauth_client_id,
            "ownerEmailHint": owner_verifier.primary_owner_hint,
            "customerWebUrl": public_config.customer_web_url,
            "adminWebUrl": public_config.admin_web_url,
            "plaidHost": SANDBOX_HOST,
            "alpacaBaseUrl": "https://paper-api.alpaca.markets",
        }

    @app.get("/api/secrets")
    def list_managed_secrets(
        caller_email: Annotated[str, Depends(require_google_owner)],
    ) -> dict[str, Any]:
        items = vault.list_secrets()
        return {
            "owner_email": caller_email,
            "secrets": [_summary_to_dict(item) for item in items],
        }

    @app.get("/api/secrets/{secret_key}/reveal")
    def reveal_managed_secret(
        secret_key: str,
        _caller_email: Annotated[str, Depends(require_google_owner)],
    ) -> dict[str, Any]:
        if secret_key not in _SPEC_BY_KEY:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown managed secret key")
        revealed = vault.reveal_secret(secret_key)
        return {
            "key": revealed.key,
            "secret_id": revealed.secret_id,
            "value": revealed.value,
            "configured": revealed.configured,
            "version": revealed.version,
        }

    @app.put("/api/secrets/{secret_key}")
    def update_managed_secret(
        secret_key: str,
        payload: SecretUpdatePayload,
        _caller_email: Annotated[str, Depends(require_google_owner)],
    ) -> dict[str, Any]:
        if secret_key not in _SPEC_BY_KEY:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown managed secret key")
        cleaned = payload.value.strip()
        if not cleaned or cleaned == UNCONFIGURED_MARKER:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "secret value must be non-empty and not the placeholder string",
            )
        updated = vault.update_secret(secret_key, cleaned)
        hot_reloaded = False
        if secret_key in ("plaid-client-id", "plaid-secret") and on_plaid_credentials_updated:
            cid = vault.get_raw_value("plaid-client-id")
            csec = vault.get_raw_value("plaid-secret")
            if cid and csec:
                on_plaid_credentials_updated(cid, csec)
                hot_reloaded = True
        return {
            "secret": _summary_to_dict(updated),
            "hot_reloaded": hot_reloaded,
        }

    @app.post("/api/plaid-verify")
    def verify_plaid_sandbox(
        _caller_email: Annotated[str, Depends(require_google_owner)],
    ) -> dict[str, Any]:
        cid = vault.get_raw_value("plaid-client-id")
        csec = vault.get_raw_value("plaid-secret")
        if not cid or not csec:
            return {
                "ok": False,
                "host": SANDBOX_HOST,
                "detail": "Plaid Client ID or Sandbox Secret is not configured yet.",
            }
        with httpx.Client(timeout=15.0) as client:
            resp = client.post(
                f"https://{SANDBOX_HOST}/institutions/get_by_id",
                json={
                    "client_id": cid,
                    "secret": csec,
                    "institution_id": SANDBOX_INSTITUTION,
                    "country_codes": ["US"],
                },
            )
        if resp.status_code == 200:
            inst_name = resp.json().get("institution", {}).get("name", SANDBOX_INSTITUTION)
            return {
                "ok": True,
                "host": SANDBOX_HOST,
                "institution": str(inst_name),
            }
        err_code = None
        try:
            err_code = resp.json().get("error_code")
        except ValueError:
            err_code = None
        return {
            "ok": False,
            "host": SANDBOX_HOST,
            "detail": f"Plaid Sandbox returned HTTP {resp.status_code} ({err_code or 'error'})",
        }

    return app


class RootPortalMiddleware:
    """Serve the API status & owner vault HTML shell ONLY on exact `GET /` or `HEAD /`.

    All other paths (`/v1/*`, `/worker/v1/*`, `/health/*`, `/admin-secrets/*`, or custom
    routes registered on `app`) pass untouched to the inner FastAPI app.
    """

    def __init__(self, app: ASGIApp, *, console_app: ASGIApp) -> None:
        self._app = app
        self._console_app = console_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and scope.get("path") == "/"
            and scope.get("method") in ("GET", "HEAD")
        ):
            await self._console_app(scope, receive, send)
            return
        await self._app(scope, receive, send)


def build_default_secret_console(
    identity_project_id: str,
    identity_signing_key: Callable[[str], jwt.PyJWK],
    *,
    on_plaid_credentials_updated: Callable[[str, str], None] | None = None,
) -> FastAPI:
    raw_allowed = os.environ.get("SECRET_ADMIN_ALLOWED_EMAILS", DEFAULT_OWNER_EMAIL)
    allowed_emails = [item.strip() for item in raw_allowed.split(",") if item.strip()]
    google_client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip()
    oidc_keys = jwt.PyJWKClient(GOOGLE_OIDC_JWKS_URL) if google_client_id else None

    owner_verifier = GoogleOwnerVerifier(
        identity_project_id=identity_project_id,
        allowed_emails=allowed_emails,
        identity_signing_key=identity_signing_key,
        google_oauth_client_id=google_client_id,
        google_oidc_signing_key=oidc_keys.get_signing_key_from_jwt if oidc_keys else None,
    )

    gcp_project = os.environ.get("GCP_PROJECT_ID", "").strip()
    name_prefix = os.environ.get("SECRET_PREFIX", "hr-finance-dev").strip()
    in_cloud_run = bool(os.environ.get("K_SERVICE"))
    vault: SecretVaultBackend
    if gcp_project and in_cloud_run:
        vault = GcpSecretManagerBackend(gcp_project, name_prefix)
    else:
        vault = InMemorySecretBackend(name_prefix)

    pub_cfg = PortalPublicConfig(
        identity_project_id=identity_project_id,
        firebase_api_key=os.environ.get("PUBLIC_FIREBASE_API_KEY", "").strip(),
        firebase_auth_domain=os.environ.get("PUBLIC_FIREBASE_AUTH_DOMAIN", "").strip(),
        google_oauth_client_id=google_client_id,
        customer_web_url=os.environ.get("PUBLIC_CUSTOMER_URL", "").strip(),
        admin_web_url=os.environ.get("PUBLIC_ADMIN_URL", "").strip(),
    )
    return create_secret_console_app(
        owner_verifier,
        vault,
        pub_cfg,
        on_plaid_credentials_updated=on_plaid_credentials_updated,
    )
