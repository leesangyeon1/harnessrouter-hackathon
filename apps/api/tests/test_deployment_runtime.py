"""Deployment runtime checks: health probes, pool reset, CORS, private worker OIDC, jobs, logs."""

from __future__ import annotations

import json
import logging
import secrets
import time
from collections.abc import Callable
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from psycopg import sql
from psycopg.conninfo import make_conninfo

from finance_api.app import create_app
from finance_api.auth import IdTokenVerifier
from finance_api.db import create_pool, tenant_transaction
from finance_api.internal_auth import ServiceOidcVerifier
from finance_api.jobs import run_job, validate_sandbox_and_paper_env
from finance_api.observability import (
    CloudLoggingFormatter,
    RedactingFilter,
    cycle_id_var,
    redact_text,
    register_secret_for_redaction,
    request_id_var,
    task_id_var,
    trace_id_var,
)
from finance_api.plaid import PlaidClient
from finance_api.sealing import SecretBox
from finance_api.task_worker import TaskDispatchPayload, create_task_worker_app

WORKER_AUDIENCE = "https://finance-worker-test.a.run.app"
INVOKER_SA = "sa-tasks-invoker@test-project.iam.gserviceaccount.com"
OTHER_SA = "sa-other@test-project.iam.gserviceaccount.com"
OIDC_KID = "oidc-kid-1"


def _make_oidc_env(
    private_key: rsa.RSAPrivateKey,
) -> tuple[ServiceOidcVerifier, Callable[..., str]]:
    public_jwk = jwt.PyJWK(
        RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True), algorithm="RS256"
    )

    def signing_key(token: str) -> jwt.PyJWK:
        if jwt.get_unverified_header(token).get("kid") != OIDC_KID:
            raise jwt.PyJWKClientError("unknown kid")
        return public_jwk

    def issue(**overrides: Any) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "iss": "https://accounts.google.com",
            "aud": WORKER_AUDIENCE,
            "sub": "1234567890",
            "email": INVOKER_SA,
            "email_verified": True,
            "iat": now,
            "exp": now + 300,
        } | overrides
        return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": OIDC_KID})

    verifier = ServiceOidcVerifier(
        audience=WORKER_AUDIENCE,
        allowed_emails=[INVOKER_SA],
        signing_key=signing_key,
    )
    return verifier, issue


def test_health_live_and_ready_succeed_for_api_role_while_v1_stays_protected(
    api_url: str,
    verifier: IdTokenVerifier,
    no_plaid: PlaidClient,
    secret_box: SecretBox,
) -> None:
    app = create_app(create_pool(api_url, open_pool=False), verifier, no_plaid, secret_box)
    with TestClient(app) as client:
        live = client.get("/health/live", headers={"X-Request-ID": "req-health-1"})
        ready = client.get("/health/ready")
        me = client.get("/v1/me")

    assert live.status_code == 200
    assert live.json() == {"status": "live"}
    assert live.headers["X-Request-ID"] == "req-health-1"
    assert ready.status_code == 200
    assert ready.json() == {"status": "ready"}
    assert me.status_code == 401


def test_health_ready_refuses_table_owner_and_superuser_roles(
    migrator_url: str,
    server_url: str,
    verifier: IdTokenVerifier,
    no_plaid: PlaidClient,
    secret_box: SecretBox,
) -> None:
    owner_app = create_app(
        create_pool(migrator_url, open_pool=False), verifier, no_plaid, secret_box
    )
    with TestClient(owner_app) as client:
        owner_ready = client.get("/health/ready")
    assert owner_ready.status_code == 503
    assert owner_ready.json()["reason"] == "unsafe_db_role:owns_public_tables"

    super_app = create_app(create_pool(server_url, open_pool=False), verifier, no_plaid, secret_box)
    with TestClient(super_app) as client:
        super_ready = client.get("/health/ready")
    assert super_ready.status_code == 503
    assert super_ready.json()["reason"] == "unsafe_db_role:superuser_or_bypassrls"


def test_pool_reset_clears_even_session_scoped_tenant_setting(api_url: str) -> None:
    alice = uuid4().hex
    with create_pool(api_url, open_pool=True, min_size=1, max_size=1) as pool:
        with tenant_transaction(pool, alice) as conn:
            conn.execute(
                "INSERT INTO reports (user_id, kind, figures) VALUES (%s, 'spending', '[]'::jsonb)",
                (alice,),
            )
        # Simulate accidental session-level set_config(is_local=false) outside a transaction.
        with pool.connection() as conn:
            with conn.transaction():
                conn.execute("SELECT set_config('app.user_id', %s, false)", (alice,))

        # Next checkout on the same single pooled connection must see empty app.user_id and 0 rows.
        with pool.connection() as conn:
            setting = conn.execute("SELECT current_setting('app.user_id', true)").fetchone()
            rows = conn.execute("SELECT count(*) FROM reports").fetchone()

    assert setting == ("",)
    assert rows == (0,)


def test_cors_validation_rejects_wildcard_and_insecure_origins(
    api_url: str,
    verifier: IdTokenVerifier,
    no_plaid: PlaidClient,
    secret_box: SecretBox,
) -> None:
    pool = create_pool(api_url, open_pool=False)
    with pytest.raises(ValueError, match="wildcard"):
        create_app(pool, verifier, no_plaid, secret_box, cors_origins=["*"])
    with pytest.raises(ValueError, match="HTTPS"):
        create_app(pool, verifier, no_plaid, secret_box, cors_origins=["http://app.example.com"])

    app = create_app(
        pool,
        verifier,
        no_plaid,
        secret_box,
        cors_origins=["https://app.example.com"],
    )
    with TestClient(app) as client:
        preflight = client.options(
            "/v1/me",
            headers={
                "Origin": "https://app.example.com",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "Authorization",
            },
        )
        disallowed = client.options(
            "/v1/me",
            headers={
                "Origin": "https://evil.example.org",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert preflight.status_code == 200
    assert preflight.headers.get("access-control-allow-origin") == "https://app.example.com"
    assert disallowed.headers.get("access-control-allow-origin") is None


def test_private_worker_rejects_unauthenticated_user_tokens_and_wrong_sa(
    api_url: str,
    private_key: rsa.RSAPrivateKey,
    make_token: Callable[..., str],
) -> None:
    oidc_verifier, issue_oidc = _make_oidc_env(private_key)
    worker_app = create_task_worker_app(create_pool(api_url, open_pool=False), oidc_verifier)
    body = {
        "user_id": "user-1",
        "task_id": str(uuid4()),
        "idempotency_key": f"idem-{uuid4().hex}",
    }

    with TestClient(worker_app) as client:
        no_auth = client.post("/internal/tasks/harness", json=body)
        user_id_token = client.post(
            "/internal/tasks/harness",
            json=body,
            headers={"Authorization": f"Bearer {make_token()}"},
        )
        wrong_aud = client.post(
            "/internal/tasks/harness",
            json=body,
            headers={"Authorization": f"Bearer {issue_oidc(aud='https://other.a.run.app')}"},
        )
        wrong_sa = client.post(
            "/internal/tasks/harness",
            json=body,
            headers={"Authorization": f"Bearer {issue_oidc(email=OTHER_SA)}"},
        )

    assert no_auth.status_code == 401
    assert user_id_token.status_code == 401
    assert wrong_aud.status_code == 401
    assert wrong_sa.status_code == 403


def test_private_worker_executes_once_on_cloud_tasks_retry_and_isolates_tenants(
    api_url: str,
    migrator_url: str,
    private_key: rsa.RSAPrivateKey,
) -> None:
    oidc_verifier, issue_oidc = _make_oidc_env(private_key)
    alice, bob = uuid4().hex, uuid4().hex
    idem_key = f"idem-{uuid4().hex}"
    calls: list[UUID] = []

    with psycopg.connect(migrator_url) as conn:
        conn.execute("SELECT set_config('app.user_id', %s, true)", (alice,))
        row = conn.execute(
            "INSERT INTO agent_tasks"
            " (user_id, kind, idempotency_key, cost_cap_usd, timeout_seconds, status)"
            " VALUES (%s, 'advisor', %s, %s, %s, 'queued') RETURNING id",
            (alice, idem_key, Decimal("0.50"), 120),
        ).fetchone()
        assert row is not None
        task_id: UUID = row[0]

    def fake_runner(_pool: Any, payload: TaskDispatchPayload, meta: dict[str, Any]) -> str:
        calls.append(payload.task_id)
        assert meta["caller_sa"] == INVOKER_SA
        return "synthetic advisory summary"

    worker_app = create_task_worker_app(
        create_pool(api_url, open_pool=False), oidc_verifier, runner=fake_runner
    )
    auth_header = {
        "Authorization": f"Bearer {issue_oidc()}",
        "X-CloudTasks-TaskName": "task-queue-item-42",
    }

    with TestClient(worker_app) as client:
        # Cross-tenant attempt with Bob's user_id cannot see Alice's task row due to forced RLS.
        cross_tenant = client.post(
            "/internal/tasks/harness",
            json={"user_id": bob, "task_id": str(task_id), "idempotency_key": idem_key},
            headers=auth_header,
        )
        first = client.post(
            "/internal/tasks/harness",
            json={"user_id": alice, "task_id": str(task_id), "idempotency_key": idem_key},
            headers=auth_header,
        )
        # Simulated Cloud Tasks retry of the exact same task payload.
        retry = client.post(
            "/internal/tasks/harness",
            json={"user_id": alice, "task_id": str(task_id), "idempotency_key": idem_key},
            headers=auth_header,
        )

    assert cross_tenant.status_code == 404
    assert first.status_code == 200
    assert first.json() == {"task_id": str(task_id), "status": "completed"}
    assert retry.status_code == 200
    assert retry.json() == {"task_id": str(task_id), "status": "already_processed"}
    assert calls == [task_id]


def test_jobs_refuse_live_alpaca_host_and_unsafe_db_roles(
    server_url: str,
    migrator_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ALPACA_PAPER_BASE_URL", "https://api.alpaca.markets")
    with pytest.raises(ValueError, match=r"paper-api\.alpaca\.markets"):
        validate_sandbox_and_paper_env()

    monkeypatch.setenv("ALPACA_PAPER_BASE_URL", "https://paper-api.alpaca.markets")
    monkeypatch.setenv("ALPACA_LIVE_ENABLED", "true")
    with pytest.raises(ValueError, match="live trading is prohibited"):
        validate_sandbox_and_paper_env()

    monkeypatch.delenv("ALPACA_LIVE_ENABLED")
    with pytest.raises(RuntimeError, match="unsafe database role"):
        run_job("market-ingest", migrator_url, entrypoint_override=lambda _conn: None)

    # Create a dedicated finance_cycle login role and verify run_job permits it.
    dbname = psycopg.conninfo.conninfo_to_dict(migrator_url)["dbname"]
    cycle_user = f"cycle_login_{secrets.token_hex(4)}"
    cycle_pw = secrets.token_urlsafe(16)
    with psycopg.connect(server_url, autocommit=True) as admin:
        admin.execute(
            sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} IN ROLE finance_cycle").format(
                sql.Identifier(cycle_user), sql.Literal(cycle_pw)
            )
        )
    cycle_url = make_conninfo(server_url, user=cycle_user, password=cycle_pw, dbname=dbname)
    ran: list[bool] = []

    def mark_ran(_conn: psycopg.Connection) -> str | None:
        ran.append(True)
        return None

    run_job("market-ingest", cycle_url, entrypoint_override=mark_ran)
    assert ran == [True]


def test_structured_logging_records_correlation_ids_and_redacts_secrets() -> None:
    secret_val = "super-secret-fernet-" + secrets.token_hex(8)
    register_secret_for_redaction(secret_val)
    formatter = CloudLoggingFormatter(project_id="demo-gcp-project")
    redactor = RedactingFilter()

    req_tok = request_id_var.set("req-123")
    task_tok = task_id_var.set("task-456")
    cycle_tok = cycle_id_var.set("cycle-789")
    trace_tok = trace_id_var.set("abcdef123456")
    try:
        raw_msg = (
            f"Auth Bearer eyJhbGciOiJSUzI1NiJ9.secret "
            f"db=postgresql://api_user:dbpass123@10.0.0.5:5432/finance "
            f"item=access-sandbox-998877 key={secret_val} plaid_secret=shh_plaid"
        )
        record = logging.LogRecord(
            name="finance_api.test",
            level=logging.ERROR,
            pathname=__file__,
            lineno=10,
            msg=raw_msg,
            args=(),
            exc_info=None,
        )
        assert redactor.filter(record) is True
        formatted = json.loads(formatter.format(record))
    finally:
        trace_id_var.reset(trace_tok)
        cycle_id_var.reset(cycle_tok)
        task_id_var.reset(task_tok)
        request_id_var.reset(req_tok)

    assert formatted["request_id"] == "req-123"
    assert formatted["task_id"] == "task-456"
    assert formatted["cycle_id"] == "cycle-789"
    assert (
        formatted["logging.googleapis.com/trace"] == "projects/demo-gcp-project/traces/abcdef123456"
    )
    msg = formatted["message"]
    assert "eyJhbGciOiJSUzI1NiJ9" not in msg
    assert "dbpass123" not in msg
    assert "access-sandbox-998877" not in msg
    assert secret_val not in msg
    assert "shh_plaid" not in msg
    assert "[REDACTED]" in redact_text(raw_msg)
