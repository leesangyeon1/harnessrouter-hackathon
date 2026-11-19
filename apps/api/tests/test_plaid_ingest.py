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
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from uuid import uuid4

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg_pool import ConnectionPool

from finance_api import plaid_probe
from finance_api.app import app_from_env, create_app
from finance_api.auth import IdTokenVerifier
from finance_api.plaid import PlaidClient
from finance_api.plaid_ingest import custom_user
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
        self.refusals: dict[str, str] = {}
        self.mutate_once_at = "never"
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
                "transactions_update_status": "HISTORICAL_UPDATE_COMPLETE",
            },
            "c1": {
                "added": [_transaction(3, 120.0, "TRAVEL", pending=True)],
                "modified": [],
                "removed": [],
                "next_cursor": "c2",
                "has_more": False,
                "transactions_update_status": "HISTORICAL_UPDATE_COMPLETE",
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
            "transactions_update_status": "HISTORICAL_UPDATE_COMPLETE",
        }

    @staticmethod
    def not_ready() -> dict[str, Any]:
        """What Plaid documents for an Item whose transactions it has not prepared yet."""
        return {
            "added": [],
            "modified": [],
            "removed": [],
            "next_cursor": "",
            "has_more": False,
            "transactions_update_status": "NOT_READY",
        }

    def _page(self, body: dict[str, Any]) -> dict[str, Any]:
        assert body.get("cursor") != "", "an empty cursor must be omitted, not sent"
        return self.pages[body.get("cursor", "")]

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
        if path in self.refusals:
            return httpx.Response(400, json={"error_code": self.refusals[path]})
        if path == "/transactions/sync" and body.get("cursor") == self.mutate_once_at:
            self.mutate_once_at = "never"
            mutated = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
            return httpx.Response(400, json={"error_code": mutated})
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
            "/transactions/sync": lambda: self._page(body),
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
    assert response.json() == {
        "accounts": 4,
        "transactions": 3,
        "liabilities": 2,
        "holdings": 1,
        "transactions_ready": True,
        "unavailable": {},
    }
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
    plaid.pages["c0"] = plaid.nothing_new("c0")
    client.post("/v1/plaid/seed", headers=signed_in)

    response = client.post("/v1/plaid/sync", headers=signed_in)

    assert response.status_code == 200
    assert response.json()["transactions"] == 0
    assert _counts(migrator_url, user)["plaid_transactions"] == 0


def test_sync_says_when_plaid_has_not_prepared_the_transactions_and_starts_over_next_time(
    client: TestClient, plaid: FakePlaid, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    prepared = plaid.pages[""]
    plaid.pages[""] = plaid.not_ready()
    client.post("/v1/plaid/seed", headers=signed_in)

    early = client.post("/v1/plaid/sync", headers=signed_in)

    assert early.status_code == 200
    assert (early.json()["transactions"], early.json()["transactions_ready"]) == (0, False)
    assert _rows(migrator_url, user, "SELECT transactions_cursor FROM plaid_items") == [(None,)]

    plaid.pages[""] = prepared
    later = client.post("/v1/plaid/sync", headers=signed_in)

    assert (later.json()["transactions"], later.json()["transactions_ready"]) == (3, True)
    assert [body.get("cursor") for body in plaid.calls("/transactions/sync")] == [None, None, "c1"]


def test_sync_starts_the_pagination_again_when_plaid_reports_a_change_during_it(
    client: TestClient, plaid: FakePlaid, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    plaid.mutate_once_at = "c1"
    client.post("/v1/plaid/seed", headers=signed_in)

    response = client.post("/v1/plaid/sync", headers=signed_in)

    assert response.status_code == 200, response.text
    assert response.json()["transactions"] == 3
    asked = [body.get("cursor") for body in plaid.calls("/transactions/sync")]
    assert asked == [None, "c1", None, "c1"]


def test_item_that_no_longer_has_liability_or_investment_accounts_keeps_none(
    client: TestClient, plaid: FakePlaid, signed_in: dict[str, str], user: str, migrator_url: str
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)
    client.post("/v1/plaid/sync", headers=signed_in)
    plaid.refusals = {
        "/liabilities/get": "NO_LIABILITY_ACCOUNTS",
        "/investments/holdings/get": "NO_INVESTMENT_ACCOUNTS",
    }

    response = client.post("/v1/plaid/sync", headers=signed_in)

    assert response.status_code == 200, response.text
    assert (response.json()["liabilities"], response.json()["holdings"]) == (0, 0)
    assert response.json()["unavailable"] == {}
    assert response.json()["transactions"] == 3


@pytest.mark.parametrize(
    "refusal", ["PRODUCT_NOT_ENABLED", "PRODUCTS_NOT_SUPPORTED", "PRODUCT_NOT_READY"]
)
def test_product_plaid_cannot_serve_is_named_and_what_was_stored_for_it_is_left(
    client: TestClient,
    plaid: FakePlaid,
    signed_in: dict[str, str],
    user: str,
    migrator_url: str,
    refusal: str,
) -> None:
    client.post("/v1/plaid/seed", headers=signed_in)
    client.post("/v1/plaid/sync", headers=signed_in)
    plaid.refusals = {"/liabilities/get": refusal, "/investments/holdings/get": refusal}

    response = client.post("/v1/plaid/sync", headers=signed_in)

    assert response.status_code == 200, response.text
    assert response.json()["unavailable"] == {"liabilities": refusal, "holdings": refusal}
    assert _counts(migrator_url, user) == {
        "plaid_accounts": 4,
        "plaid_transactions": 3,
        "plaid_liabilities": 2,
        "plaid_holdings": 1,
    }


def test_seed_configuration_follows_plaids_custom_user_schema() -> None:
    today = date(2027, 6, 1)

    accounts = custom_user(today)["override_accounts"]

    assert len(accounts) <= 10
    transactions = [entry for account in accounts for entry in account.get("transactions", [])]
    assert transactions, "the spending demo needs transactions"
    for entry in transactions:
        assert set(entry) == {"date_transacted", "date_posted", "amount", "description", "currency"}
        posted = date.fromisoformat(entry["date_posted"])
        # Not in the future, which Plaid would hold as pending, and inside the 90 days of
        # history Plaid returns by default (F8).
        assert timedelta(days=1) <= today - posted <= timedelta(days=90)
    liabilities = [account["liability"] for account in accounts if "liability" in account]
    assert {liability["type"] for liability in liabilities} <= {
        "credit",
        "student",
        "loan",
        "line_of_credit",
    }
    for liability in liabilities:
        if liability["type"] == "loan":
            assert set(liability["interest_rate"]) == {"percentage", "type"}
            assert liability["interest_rate"]["type"] in ("fixed", "variable")
            assert "nominal_apr" not in liability
        if liability["type"] == "credit":
            assert 0 <= liability["purchase_apr"] <= 100
    for account in accounts:
        for holding in account.get("holdings", []):
            assert {"ticker_symbol", "currency"} <= set(holding["security"])


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
        "transactions_update_status": "HISTORICAL_UPDATE_COMPLETE",
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


CUSTOM_USER = {"override_accounts": [{"type": "depository"}] * 4}


def _no_wait(seconds: float) -> None:
    pass


def test_probe_reads_a_seeded_item_back_and_prints_no_credential(plaid: FakePlaid) -> None:
    report = plaid_probe.probe(plaid.client(), CUSTOM_USER, pause=_no_wait)

    assert report["seed"] == "ok"
    assert (report["accounts"]["count"], report["accounts"]["configured"]) == (4, 4)
    assert report["transactions"] == {
        "count": 3,
        "attempts": 1,
        "ready": True,
        "without_category": 1,
        "pending": 1,
    }
    assert report["liabilities"] == {"credit": 1, "mortgage": 0, "student": 1}
    assert report["holdings"] == {"count": 1, "securities": 1}
    assert report["spending_demo_ready"] is True
    printed = json.dumps(report)
    for secret in (plaid.access_token, plaid.item_id, plaid.public_token, PLAID_SECRET):
        assert secret not in printed


def test_probe_waits_for_transactions_that_are_not_ready_at_once(plaid: FakePlaid) -> None:
    ready = plaid.pages[""]
    plaid.pages[""] = plaid.not_ready()
    waits: list[float] = []

    def wait(seconds: float) -> None:
        waits.append(seconds)
        if len(waits) == 2:
            plaid.pages[""] = ready

    report = plaid_probe.probe(plaid.client(), CUSTOM_USER, pause=wait)

    assert (report["transactions"]["count"], report["transactions"]["attempts"]) == (3, 3)
    assert report["spending_demo_ready"] is True


def test_probe_gives_up_when_no_transaction_ever_arrives(plaid: FakePlaid) -> None:
    plaid.pages[""] = plaid.not_ready()

    report = plaid_probe.probe(plaid.client(), CUSTOM_USER, pause=_no_wait, attempts=3)

    assert (report["transactions"]["count"], report["transactions"]["attempts"]) == (0, 3)
    assert report["transactions"]["ready"] is False
    assert report["spending_demo_ready"] is False


def test_probe_names_plaids_error_for_a_step_that_fails_and_goes_on(plaid: FakePlaid) -> None:
    plaid.failing = "/liabilities/get"

    report = plaid_probe.probe(plaid.client(), CUSTOM_USER, pause=_no_wait)

    assert report["liabilities"] == {"error": "INTERNAL_SERVER_ERROR"}
    assert report["holdings"] == {"count": 1, "securities": 1}
    assert report["spending_demo_ready"] is True


def test_probe_stops_at_a_seed_that_plaid_refuses(plaid: FakePlaid) -> None:
    plaid.failing = "/sandbox/public_token/create"

    report = plaid_probe.probe(plaid.client(), CUSTOM_USER, pause=_no_wait)

    assert report == {"seed": {"error": "INTERNAL_SERVER_ERROR"}, "spending_demo_ready": False}


def test_probe_command_prints_the_report_and_exits_by_readiness(
    plaid: FakePlaid, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(plaid_probe, "plaid_client_from_env", plaid.client)

    status = plaid_probe.main()

    printed = capsys.readouterr().out
    assert status == 0
    assert json.loads(printed)["spending_demo_ready"] is True
    assert json.loads(printed)["accounts"]["configured"] == 6
    assert plaid.access_token not in printed
