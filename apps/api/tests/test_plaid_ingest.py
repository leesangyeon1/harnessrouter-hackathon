"""U2: the Sandbox Item is seeded and synced, and its access token stays sealed (I1, I8).

Plaid is answered here as its documentation describes it. No response shape below has been
seen from the real Sandbox; U0 (a) is what checks them.
"""

import json
import logging
import secrets
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from typing import Any
from uuid import uuid4

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg_pool import ConnectionPool

from finance_api.app import app_from_env, create_app
from finance_api.auth import IdTokenVerifier
from finance_api.plaid import PlaidClient
from finance_api.sealing import SecretBox

MakeToken = Callable[..., str]

CLIENT_ID = "client-id"
PLAID_SECRET = "plaid-secret-" + secrets.token_hex(8)


def _transaction(number: int, amount: float, category: str | None, pending: bool = False) -> Any:
    return {
        "transaction_id": f"tx-{number}",
        "account_id": "acc-card",
        "date": f"2026-10-{number:02d}",
        "amount": amount,
        "name": f"Merchant {number}",
        "personal_finance_category": None if category is None else {"primary": category},
        "pending": pending,
    }


def _balances(current: float) -> dict[str, Any]:
    return {"current": current, "available": current, "iso_currency_code": "USD"}


class FakePlaid:
    """One Sandbox Item, answered as Plaid documents its endpoints."""

    def __init__(self) -> None:
        self.access_token = "access-sandbox-" + secrets.token_hex(8)
        self.item_id = "item-" + secrets.token_hex(4)
        self.public_token = "public-sandbox-" + secrets.token_hex(4)
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.failing: str | None = None
        self.all_read_together: threading.Barrier | None = None
        self.accounts: list[dict[str, Any]] = [
            {
                "account_id": "acc-savings",
                "name": "Savings",
                "type": "depository",
                "subtype": "savings",
                "balances": _balances(12000.5),
            },
            {
                "account_id": "acc-card",
                "name": "Card",
                "type": "credit",
                "subtype": "credit card",
                "balances": _balances(2400.1),
            },
            {
                "account_id": "acc-student",
                "name": "Student loan",
                "type": "loan",
                "subtype": "student",
                "balances": _balances(18000),
            },
            {
                "account_id": "acc-brokerage",
                "name": "Brokerage",
                "type": "investment",
                "subtype": "brokerage",
                "balances": _balances(4200.75),
            },
        ]
        self.pages: dict[str, dict[str, Any]] = {
            "": {
                "added": [_transaction(1, 42.17, "FOOD_AND_DRINK"), _transaction(2, 9.99, None)],
                "modified": [],
                "removed": [],
                "next_cursor": "c1",
                "has_more": True,
            },
            "c1": {
                "added": [_transaction(3, 120.0, "TRAVEL", pending=True)],
                "modified": [],
                "removed": [],
                "next_cursor": "c2",
                "has_more": False,
            },
            "c2": self.nothing_new("c2"),
        }
        self.credit: list[dict[str, Any]] = [
            {
                "account_id": "acc-card",
                "aprs": [
                    {"apr_percentage": 24.99, "apr_type": "purchase_apr"},
                    {"apr_percentage": 29.99, "apr_type": "cash_apr"},
                ],
                "last_statement_balance": 2350.0,
                "minimum_payment_amount": 60.0,
                "next_payment_due_date": "2026-12-01",
            }
        ]
        self.student: list[dict[str, Any]] = [
            {
                "account_id": "acc-student",
                "interest_rate_percentage": 5.8,
                "expected_payoff_date": "2034-06-01",
                "minimum_payment_amount": 198.5,
                "last_statement_balance": 18100.0,
                "next_payment_due_date": "2026-12-05",
            }
        ]
        self.holdings: list[dict[str, Any]] = [
            {
                "account_id": "acc-brokerage",
                "security_id": "sec-1",
                "quantity": 10.5,
                "institution_value": 4200.75,
            }
        ]
        self.securities = [{"security_id": "sec-1", "ticker_symbol": "VTI"}]

    @staticmethod
    def nothing_new(cursor: str) -> dict[str, Any]:
        return {
            "added": [],
            "modified": [],
            "removed": [],
            "next_cursor": cursor,
            "has_more": False,
        }

    def client(self) -> PlaidClient:
        transport = httpx.MockTransport(self._answer)
        return PlaidClient(CLIENT_ID, PLAID_SECRET, httpx.Client(transport=transport))

    def calls(self, path: str) -> list[dict[str, Any]]:
        return [body for called, body in self.requests if called == path]

    def _answer(self, request: httpx.Request) -> httpx.Response:
        path, body = request.url.path, json.loads(request.content)
        self.requests.append((path, body))
        assert (request.url.scheme, request.url.host) == ("https", "sandbox.plaid.com")
        assert (body["client_id"], body["secret"]) == (CLIENT_ID, PLAID_SECRET)
        if path == self.failing:
            return httpx.Response(400, json={"error_code": "INTERNAL_SERVER_ERROR"})
        if path == "/sandbox/public_token/create":
            return httpx.Response(200, json={"public_token": self.public_token})
        if path == "/item/public_token/exchange":
            assert body["public_token"] == self.public_token
            item = {"access_token": self.access_token, "item_id": self.item_id}
            return httpx.Response(200, json=item)
        assert body["access_token"] == self.access_token
        if path == "/investments/holdings/get" and self.all_read_together is not None:
            self.all_read_together.wait(timeout=10)
        answers: dict[str, Callable[[], dict[str, Any]]] = {
            "/accounts/get": lambda: {"accounts": self.accounts},
            "/transactions/sync": lambda: self.pages[body.get("cursor", "")],
            "/liabilities/get": lambda: {
                "liabilities": {"credit": self.credit, "student": self.student, "mortgage": []}
            },
            "/investments/holdings/get": lambda: {
                "holdings": self.holdings,
                "securities": self.securities,
            },
        }
        return httpx.Response(200, json=answers[path]())


@pytest.fixture
def plaid() -> FakePlaid:
    return FakePlaid()


@pytest.fixture
def client(
    api_url: str, verifier: IdTokenVerifier, secret_box: SecretBox, plaid: FakePlaid
) -> Iterator[TestClient]:
    app = create_app(ConnectionPool(api_url, open=False), verifier, plaid.client(), secret_box)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def user() -> str:
    return uuid4().hex


@pytest.fixture
def signed_in(make_token: MakeToken, user: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(sub=user)}"}


def _rows(migrator_url: str, user: str, query: str) -> list[tuple[Any, ...]]:
    """The user's rows, read as an operator would."""
    with psycopg.connect(migrator_url) as conn:
        conn.execute("SELECT set_config('app.user_id', %s, true)", (user,))
        return conn.execute(query.encode()).fetchall()


def _counts(migrator_url: str, user: str) -> dict[str, int]:
    tables = ("plaid_accounts", "plaid_transactions", "plaid_liabilities", "plaid_holdings")
    return {
        table: _rows(migrator_url, user, f"SELECT count(*) FROM {table}")[0][0]  # noqa: S608
        for table in tables
    }


def _everything(migrator_url: str, user: str) -> list[list[tuple[Any, ...]]]:
    return [
        _rows(migrator_url, user, query)
        for query in (
            "SELECT plaid_account_id, type, subtype, current_balance FROM plaid_accounts"
            " ORDER BY plaid_account_id",
            "SELECT plaid_transaction_id, posted_on::text, amount, name,"
            " personal_finance_category, pending FROM plaid_transactions"
            " ORDER BY plaid_transaction_id",
            "SELECT kind, aprs, interest_rate, maturity_on::text FROM plaid_liabilities"
            " ORDER BY kind",
            "SELECT security_id, ticker, quantity, institution_value FROM plaid_holdings"
            " ORDER BY security_id",
        )
    ]


def test_seed_creates_a_custom_user_item_and_stores_its_token_sealed(
    client: TestClient,
    plaid: FakePlaid,
    secret_box: SecretBox,
    signed_in: dict[str, str],
    user: str,
    migrator_url: str,
) -> None:
    response = client.post("/v1/plaid/seed", headers=signed_in)

    assert response.status_code == 201, response.text
    (created,) = plaid.calls("/sandbox/public_token/create")
    assert created["options"]["override_username"] == "user_custom"
    assert "override_accounts" in json.loads(created["options"]["override_password"])
    ((item_id, sealed),) = _rows(
        migrator_url, user, "SELECT plaid_item_id, access_token_enc FROM plaid_items"
    )
    assert item_id == plaid.item_id
    assert plaid.access_token.encode() not in sealed
    assert secret_box.open(sealed) == plaid.access_token


def test_second_seed_is_refused_and_creates_no_second_item(
    client: TestClient,
    plaid: FakePlaid,
    signed_in: dict[str, str],
    user: str,
    migrator_url: str,
) -> None:
    assert client.post("/v1/plaid/seed", headers=signed_in).status_code == 201

    again = client.post("/v1/plaid/seed", headers=signed_in)

    assert again.status_code == 409
    assert len(plaid.calls("/sandbox/public_token/create")) == 1
    assert _rows(migrator_url, user, "SELECT count(*) FROM plaid_items") == [(1,)]


def test_sync_before_seed_is_refused(client: TestClient, signed_in: dict[str, str]) -> None:
    assert client.post("/v1/plaid/sync", headers=signed_in).status_code == 409


def test_sync_stores_what_plaid_holds(
    client: TestClient, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)

    response = client.post("/v1/plaid/sync", headers=signed_in)

    assert response.status_code == 200, response.text
    assert response.json() == {"accounts": 4, "transactions": 3, "liabilities": 2, "holdings": 1}
    accounts, transactions, liabilities, holdings = _everything(migrator_url, user)
    assert accounts == [
        ("acc-brokerage", "investment", "brokerage", Decimal("4200.75")),
        ("acc-card", "credit", "credit card", Decimal("2400.1")),
        ("acc-savings", "depository", "savings", Decimal("12000.5")),
        ("acc-student", "loan", "student", Decimal("18000")),
    ]
    assert transactions == [
        ("tx-1", "2026-10-01", Decimal("42.17"), "Merchant 1", "FOOD_AND_DRINK", False),
        ("tx-2", "2026-10-02", Decimal("9.99"), "Merchant 2", None, False),
        ("tx-3", "2026-10-03", Decimal("120.0"), "Merchant 3", "TRAVEL", True),
    ]
    assert liabilities == [
        (
            "credit",
            [
                {"apr_percentage": "24.99", "apr_type": "purchase_apr"},
                {"apr_percentage": "29.99", "apr_type": "cash_apr"},
            ],
            None,
            None,
        ),
        ("student", None, Decimal("5.8"), "2034-06-01"),
    ]
    assert holdings == [("sec-1", "VTI", Decimal("10.5"), Decimal("4200.75"))]


def test_second_sync_adds_no_rows(
    client: TestClient, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)
    client.post("/v1/plaid/sync", headers=signed_in)
    first = _everything(migrator_url, user)

    again = client.post("/v1/plaid/sync", headers=signed_in)

    assert again.status_code == 200
    assert _everything(migrator_url, user) == first


def test_sync_resumes_from_the_stored_cursor(
    client: TestClient, plaid: FakePlaid, signed_in: dict[str, str]
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)
    client.post("/v1/plaid/sync", headers=signed_in)

    client.post("/v1/plaid/sync", headers=signed_in)

    cursors = [body.get("cursor") for body in plaid.calls("/transactions/sync")]
    assert cursors == [None, "c1", "c2"]


def test_two_syncs_at_once_leave_the_rows_of_one(
    client: TestClient, plaid: FakePlaid, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)
    # Each sync reads holdings last. Neither gets its answer until both have asked.
    plaid.all_read_together = threading.Barrier(2)

    def sync() -> int:
        status: int = client.post("/v1/plaid/sync", headers=signed_in).status_code
        return status

    with ThreadPoolExecutor(2) as callers:
        statuses = [call.result() for call in [callers.submit(sync), callers.submit(sync)]]

    assert statuses == [200, 200]
    assert _counts(migrator_url, user) == {
        "plaid_accounts": 4,
        "plaid_transactions": 3,
        "plaid_liabilities": 2,
        "plaid_holdings": 1,
    }


def test_item_with_no_transactions_syncs_to_an_empty_set(
    client: TestClient, plaid: FakePlaid, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    plaid.pages[""] = plaid.nothing_new("c0")
    client.post("/v1/plaid/seed", headers=signed_in)

    response = client.post("/v1/plaid/sync", headers=signed_in)

    assert response.status_code == 200
    assert response.json()["transactions"] == 0
    assert _counts(migrator_url, user)["plaid_transactions"] == 0


def test_later_sync_applies_modified_and_removed_transactions(
    client: TestClient, plaid: FakePlaid, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)
    client.post("/v1/plaid/sync", headers=signed_in)
    plaid.pages["c2"] = {
        "added": [_transaction(4, 5.0, "TRANSPORTATION")],
        "modified": [_transaction(3, 118.5, "TRAVEL")],
        "removed": [{"transaction_id": "tx-2"}],
        "next_cursor": "c3",
        "has_more": False,
    }
    plaid.pages["c3"] = plaid.nothing_new("c3")

    client.post("/v1/plaid/sync", headers=signed_in)

    stored = _rows(
        migrator_url,
        user,
        "SELECT plaid_transaction_id, amount, pending FROM plaid_transactions"
        " ORDER BY plaid_transaction_id",
    )
    assert stored == [
        ("tx-1", Decimal("42.17"), False),
        ("tx-3", Decimal("118.5"), False),
        ("tx-4", Decimal("5.0"), False),
    ]


def test_holding_that_plaid_no_longer_reports_is_removed(
    client: TestClient, plaid: FakePlaid, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)
    client.post("/v1/plaid/sync", headers=signed_in)
    plaid.holdings = []

    client.post("/v1/plaid/sync", headers=signed_in)

    assert _counts(migrator_url, user)["plaid_holdings"] == 0


def test_failed_sync_stores_nothing(
    client: TestClient, plaid: FakePlaid, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)
    plaid.failing = "/investments/holdings/get"

    response = client.post("/v1/plaid/sync", headers=signed_in)

    assert response.status_code == 502
    assert "INTERNAL_SERVER_ERROR" in response.text
    assert set(_counts(migrator_url, user).values()) == {0}
    assert _rows(migrator_url, user, "SELECT transactions_cursor FROM plaid_items") == [(None,)]


def test_no_response_or_log_line_contains_the_token_or_the_plaid_secret(
    client: TestClient,
    plaid: FakePlaid,
    signed_in: dict[str, str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)

    responses = [
        client.post("/v1/plaid/seed", headers=signed_in),
        client.post("/v1/plaid/sync", headers=signed_in),
    ]
    plaid.failing = "/liabilities/get"
    responses.append(client.post("/v1/plaid/sync", headers=signed_in))

    assert [response.status_code for response in responses] == [201, 200, 502]
    said = caplog.text + "".join(response.text for response in responses)
    assert plaid.access_token not in said
    assert PLAID_SECRET not in said
    assert "sandbox.plaid.com" in caplog.text, "nothing was logged, so the check proves nothing"


def test_one_users_sync_stores_nothing_for_another(
    client: TestClient, signed_in: dict[str, str], migrator_url: str
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)
    client.post("/v1/plaid/sync", headers=signed_in)

    assert set(_counts(migrator_url, uuid4().hex).values()) == {0}


@pytest.mark.parametrize(
    "host", ["production.plaid.com", "development.plaid.com", "sandbox.plaid.com.example.org"]
)
def test_configuration_naming_another_plaid_host_is_refused_at_start(
    api_url: str, secret_box_key: str, monkeypatch: pytest.MonkeyPatch, host: str
) -> None:
    monkeypatch.setenv("DATABASE_URL", api_url)
    monkeypatch.setenv("IDENTITY_PROJECT_ID", "demo-project")
    monkeypatch.setenv("PLAID_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("PLAID_SECRET", PLAID_SECRET)
    monkeypatch.setenv("SECRET_BOX_KEY", secret_box_key)
    monkeypatch.setenv("PLAID_HOST", host)

    with pytest.raises(ValueError, match=r"sandbox\.plaid\.com"):
        app_from_env()
