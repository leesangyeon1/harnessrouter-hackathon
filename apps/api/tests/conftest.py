import os
import secrets
import time
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import jwt
import psycopg
import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm
from psycopg import sql
from psycopg.conninfo import make_conninfo

from finance_api.auth import IdTokenVerifier
from finance_api.migrate import apply_migrations
from finance_api.plaid import PlaidClient
from finance_api.sealing import SecretBox

MIGRATOR = "test_migrator"
API_LOGIN = "test_api"
PASSWORD = "test-only"  # noqa: S105
PROJECT = "demo-project"
KID = "test-kid"


@pytest.fixture(scope="session")
def server_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    """Superuser URL of a PostgreSQL server: CI's service, or one started here."""
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        yield url
        return
    from pgserver.postgres_server import get_server

    server = get_server(tmp_path_factory.mktemp("pg") / "data", cleanup_mode="stop")
    try:
        yield server.get_uri()
    finally:
        server.cleanup()


def _ensure_login_role(admin: psycopg.Connection, name: str, attributes: str) -> None:
    exists = admin.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,)).fetchone()
    if exists is None:
        admin.execute(
            sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} " + attributes).format(
                sql.Identifier(name), sql.Literal(PASSWORD)
            )
        )


def _create_database(server_url: str) -> tuple[str, str]:
    """Create an empty database owned by the migrator. Returns its name and the migrator's URL."""
    name = f"finance_test_{secrets.token_hex(4)}"
    with psycopg.connect(server_url, autocommit=True) as admin:
        _ensure_login_role(admin, MIGRATOR, "CREATEROLE")
        admin.execute(
            sql.SQL("CREATE DATABASE {} OWNER {}").format(
                sql.Identifier(name), sql.Identifier(MIGRATOR)
            )
        )
    return name, make_conninfo(server_url, user=MIGRATOR, password=PASSWORD, dbname=name)


def _drop_database(server_url: str, name: str) -> None:
    with psycopg.connect(server_url, autocommit=True) as admin:
        admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest.fixture
def fresh_database_url(server_url: str) -> Iterator[str]:
    """Migrator URL of a database no migration has touched."""
    name, migrator_url = _create_database(server_url)
    yield migrator_url
    _drop_database(server_url, name)


@pytest.fixture(scope="session")
def _migrated_urls(server_url: str) -> Iterator[tuple[str, str]]:
    name, migrator_url = _create_database(server_url)
    with psycopg.connect(migrator_url) as conn:
        apply_migrations(conn)
    with psycopg.connect(server_url, autocommit=True) as admin:
        _ensure_login_role(admin, API_LOGIN, "IN ROLE finance_api")
    yield migrator_url, make_conninfo(server_url, user=API_LOGIN, password=PASSWORD, dbname=name)
    _drop_database(server_url, name)


@pytest.fixture
def migrator_url(_migrated_urls: tuple[str, str]) -> str:
    """The migrated database as the role that owns every table. Not a superuser."""
    return _migrated_urls[0]


@pytest.fixture
def api_url(_migrated_urls: tuple[str, str]) -> str:
    """The migrated database as a login member of finance_api."""
    return _migrated_urls[1]


@pytest.fixture(scope="session")
def private_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="session")
def make_token(private_key: rsa.RSAPrivateKey) -> Callable[..., str]:
    """An ID token as Identity Platform issues it. A keyword replaces a claim; None removes it."""

    def make(**claims: Any) -> str:
        now = int(time.time())
        payload = {
            "iss": f"https://securetoken.google.com/{PROJECT}",
            "aud": PROJECT,
            "sub": "user-1",
            "iat": now,
            "exp": now + 3600,
        } | claims
        present = {name: value for name, value in payload.items() if value is not None}
        return jwt.encode(present, private_key, algorithm="RS256", headers={"kid": KID})

    return make


@pytest.fixture(scope="session")
def verifier(private_key: rsa.RSAPrivateKey) -> IdTokenVerifier:
    """Verifies against the test project's one key, as the key service would serve it."""
    public_key = jwt.PyJWK(
        RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True), algorithm="RS256"
    )

    def signing_key(token: str) -> jwt.PyJWK:
        if jwt.get_unverified_header(token).get("kid") != KID:
            raise jwt.PyJWKClientError("no signing key matches the token's kid")
        return public_key

    return IdTokenVerifier(PROJECT, signing_key)


@pytest.fixture(scope="session")
def secret_box_key() -> str:
    return Fernet.generate_key().decode()


@pytest.fixture(scope="session")
def secret_box(secret_box_key: str) -> SecretBox:
    return SecretBox(secret_box_key)


@pytest.fixture(scope="session")
def no_plaid() -> PlaidClient:
    """A Plaid client for tests in which nothing may reach Plaid."""

    def refuse(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected request to Plaid: {request.url}")

    return PlaidClient("client-id", "secret", httpx.Client(transport=httpx.MockTransport(refuse)))
