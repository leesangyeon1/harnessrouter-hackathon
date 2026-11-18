"""U1: the ID token is verified on every request, and the role is read at request time."""

import time
from collections.abc import Callable, Iterator
from typing import Any
from uuid import uuid4

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from psycopg_pool import ConnectionPool

from finance_api.app import app_from_env, create_app
from finance_api.auth import IdTokenVerifier
from finance_api.worker_api import hash_token

PROJECT = "demo-project"
KID = "test-kid"
USER = "user-1"
ADMIN_ACTION = "/v1/admin/worker-tokens"

MakeToken = Callable[..., str]


@pytest.fixture(scope="module")
def private_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def make_token(private_key: rsa.RSAPrivateKey) -> MakeToken:
    """An ID token as Identity Platform issues it. A keyword replaces a claim; None removes it."""

    def make(**claims: Any) -> str:
        now = int(time.time())
        payload = {
            "iss": f"https://securetoken.google.com/{PROJECT}",
            "aud": PROJECT,
            "sub": USER,
            "iat": now,
            "exp": now + 3600,
        } | claims
        present = {name: value for name, value in payload.items() if value is not None}
        return jwt.encode(present, private_key, algorithm="RS256", headers={"kid": KID})

    return make


def _app(api_url: str, signing_key: Callable[[str], jwt.PyJWK]) -> FastAPI:
    app = create_app(ConnectionPool(api_url, open=False), IdTokenVerifier(PROJECT, signing_key))
    app.get("/declares-no-sign-in")(lambda: {"ok": True})
    return app


@pytest.fixture
def client(api_url: str, private_key: rsa.RSAPrivateKey) -> Iterator[TestClient]:
    public_key = jwt.PyJWK(
        RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True), algorithm="RS256"
    )

    def signing_key(token: str) -> jwt.PyJWK:
        if jwt.get_unverified_header(token).get("kid") != KID:
            raise jwt.PyJWKClientError("no signing key matches the token's kid")
        return public_key

    with TestClient(_app(api_url, signing_key)) as test_client:
        yield test_client


def _set_role(migrator_url: str, user_id: str, role: str | None) -> None:
    """Change the role in the database, as an operator would."""
    with psycopg.connect(migrator_url) as conn:
        conn.execute("SELECT set_config('app.user_id', %s, true)", (user_id,))
        conn.execute("DELETE FROM user_roles WHERE user_id = %s", (user_id,))
        if role is not None:
            conn.execute("INSERT INTO user_roles (user_id, role) VALUES (%s, %s)", (user_id, role))


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_request_with_no_token_is_refused(client: TestClient) -> None:
    response = client.get("/v1/me")

    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_route_that_declares_no_sign_in_still_refuses_a_request_with_no_token(
    client: TestClient,
) -> None:
    assert client.get("/declares-no-sign-in").status_code == 401


def test_request_with_another_scheme_is_refused(client: TestClient, make_token: MakeToken) -> None:
    response = client.get("/v1/me", headers={"Authorization": f"Basic {make_token()}"})

    assert response.status_code == 401


def _signed_by_another_key(make_token: MakeToken) -> str:
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    claims = jwt.decode(make_token(), options={"verify_signature": False})
    return jwt.encode(claims, other_key, algorithm="RS256", headers={"kid": KID})


def _unsigned(make_token: MakeToken) -> str:
    claims = jwt.decode(make_token(), options={"verify_signature": False})
    return jwt.encode(claims, "", algorithm="none", headers={"kid": KID})


def _unknown_kid(make_token: MakeToken) -> str:
    rest = make_token().split(".", 1)[1]
    forged = jwt.utils.base64url_encode(b'{"alg":"RS256","kid":"other","typ":"JWT"}').decode()
    return f"{forged}.{rest}"


BAD_TOKENS: dict[str, Callable[[MakeToken], str]] = {
    "not a token": lambda make: "garbage",
    "signed by another key": _signed_by_another_key,
    "unsigned": _unsigned,
    "unknown key id": _unknown_kid,
    "expired": lambda make: make(exp=int(time.time()) - 1),
    "another project's audience": lambda make: make(aud="other-project"),
    "another issuer": lambda make: make(iss="https://securetoken.google.com/other-project"),
    "empty subject": lambda make: make(sub=""),
    "no expiry": lambda make: make(exp=None),
}


@pytest.mark.parametrize("build", BAD_TOKENS.values(), ids=BAD_TOKENS.keys())
def test_bad_token_is_refused(
    client: TestClient, make_token: MakeToken, build: Callable[[MakeToken], str]
) -> None:
    response = client.get("/v1/me", headers=_bearer(build(make_token)))

    assert response.status_code == 401


def test_signed_in_request_is_served_as_its_user(client: TestClient, make_token: MakeToken) -> None:
    response = client.get("/v1/me", headers=_bearer(make_token()))

    assert response.status_code == 200
    assert response.json() == {"user_id": USER, "role": "user"}


def test_unreachable_key_service_is_not_reported_as_a_bad_token(
    api_url: str, make_token: MakeToken
) -> None:
    def signing_key(token: str) -> jwt.PyJWK:
        raise jwt.PyJWKClientConnectionError("key service unreachable")

    with TestClient(_app(api_url, signing_key), raise_server_exceptions=False) as client:
        response = client.get("/v1/me", headers=_bearer(make_token()))

    assert response.status_code == 500


def test_user_is_refused_an_admin_action(client: TestClient, make_token: MakeToken) -> None:
    response = client.post(ADMIN_ACTION, headers=_bearer(make_token(sub="plain-user")))

    assert response.status_code == 403


def test_admin_loses_the_action_when_the_role_is_removed_without_signing_in_again(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    token = make_token(sub="admin-1")
    _set_role(migrator_url, "admin-1", "admin")
    assert client.post(ADMIN_ACTION, headers=_bearer(token)).status_code == 201
    assert client.get("/v1/me", headers=_bearer(token)).json()["role"] == "admin"

    _set_role(migrator_url, "admin-1", None)

    assert client.post(ADMIN_ACTION, headers=_bearer(token)).status_code == 403
    assert client.get("/v1/me", headers=_bearer(token)).json()["role"] == "user"


def test_one_users_admin_role_does_not_reach_another_user(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    _set_role(migrator_url, "admin-2", "admin")

    response = client.post(ADMIN_ACTION, headers=_bearer(make_token(sub="someone-else")))

    assert response.status_code == 403


def test_user_is_refused_revoking_a_worker_token(client: TestClient, make_token: MakeToken) -> None:
    response = client.delete(
        f"{ADMIN_ACTION}/{uuid4()}", headers=_bearer(make_token(sub="plain-user"))
    )

    assert response.status_code == 403


def test_admin_issues_a_worker_token_that_only_the_worker_api_accepts(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    _set_role(migrator_url, "admin-3", "admin")

    issued = client.post(ADMIN_ACTION, headers=_bearer(make_token(sub="admin-3")))

    assert issued.status_code == 201
    token = issued.json()["token"]
    assert client.post("/worker/v1/claim", headers=_bearer(token)).status_code in (200, 204)
    assert client.get("/v1/me", headers=_bearer(token)).status_code == 401
    with psycopg.connect(migrator_url) as conn:
        stored = conn.execute(
            "SELECT token_hash FROM worker_tokens WHERE id = %s", (issued.json()["id"],)
        ).fetchone()
    assert stored == (hash_token(token),)


def test_worker_token_revoked_by_an_admin_is_refused(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    _set_role(migrator_url, "admin-4", "admin")
    admin = _bearer(make_token(sub="admin-4"))
    issued = client.post(ADMIN_ACTION, headers=admin).json()

    revoked = client.delete(f"{ADMIN_ACTION}/{issued['id']}", headers=admin)

    assert revoked.status_code == 204
    assert client.post("/worker/v1/claim", headers=_bearer(issued["token"])).status_code == 401
    assert client.delete(f"{ADMIN_ACTION}/{issued['id']}", headers=admin).status_code == 404


def test_admin_lists_worker_tokens_without_their_secrets(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    _set_role(migrator_url, "admin-5", "admin")
    admin = _bearer(make_token(sub="admin-5"))
    revoked = client.post(ADMIN_ACTION, headers=admin).json()
    client.delete(f"{ADMIN_ACTION}/{revoked['id']}", headers=admin)
    live = client.post(ADMIN_ACTION, headers=admin).json()

    listed = client.get(ADMIN_ACTION, headers=admin)

    assert listed.status_code == 200
    tokens = {token["id"]: token for token in listed.json()["tokens"]}
    assert set(tokens[live["id"]]) == {"id", "created_at", "revoked_at"}
    assert tokens[live["id"]]["revoked_at"] is None
    assert tokens[revoked["id"]]["revoked_at"] is not None
    assert live["token"] not in listed.text
    assert revoked["token"] not in listed.text


def test_user_is_refused_the_list_of_worker_tokens(
    client: TestClient, make_token: MakeToken
) -> None:
    response = client.get(ADMIN_ACTION, headers=_bearer(make_token(sub="plain-user")))

    assert response.status_code == 403


def test_id_token_is_refused_by_the_worker_api(client: TestClient, make_token: MakeToken) -> None:
    assert client.post("/worker/v1/claim", headers=_bearer(make_token())).status_code == 401


def test_service_built_from_the_environment_verifies_tokens(
    api_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATABASE_URL", api_url)
    monkeypatch.setenv("IDENTITY_PROJECT_ID", PROJECT)

    with TestClient(app_from_env()) as client:
        response = client.get("/v1/me")

    assert response.status_code == 401
