"""U3, spending only: the figures come from the caller's stored transactions (I2, I7)."""

from collections.abc import Callable, Iterator
from datetime import date
from decimal import Decimal
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg_pool import ConnectionPool

from finance_api.app import create_app
from finance_api.auth import IdTokenVerifier
from finance_api.plaid import PlaidClient
from finance_api.sealing import SecretBox

MakeToken = Callable[..., str]

# posted on, amount, category, pending
TRANSACTIONS: list[tuple[str, str, str | None, bool]] = [
    ("2026-10-03", "84.20", "FOOD_AND_DRINK", False),
    ("2026-10-19", "42.17", "FOOD_AND_DRINK", False),
    ("2026-10-09", "46.50", "TRANSPORTATION", False),
    ("2026-10-21", "9.99", None, False),
    ("2026-10-30", "500.00", "TRAVEL", True),  # pending: left out
    ("2026-11-02", "91.75", "FOOD_AND_DRINK", False),
    ("2026-11-05", "-20.00", "FOOD_AND_DRINK", False),  # a refund
]
# By hand: October food 84.20 + 42.17, November food 91.75 - 20.00.
SPENDING = [
    {"month": "2026-10", "category": "FOOD_AND_DRINK", "amount": "126.37"},
    {"month": "2026-10", "category": "TRANSPORTATION", "amount": "46.50"},
    {"month": "2026-10", "category": "UNCATEGORIZED", "amount": "9.99"},
    {"month": "2026-11", "category": "FOOD_AND_DRINK", "amount": "71.75"},
]


@pytest.fixture
def client(
    api_url: str, verifier: IdTokenVerifier, no_plaid: PlaidClient, secret_box: SecretBox
) -> Iterator[TestClient]:
    app = create_app(ConnectionPool(api_url, open=False), verifier, no_plaid, secret_box)
    with TestClient(app) as test_client:
        yield test_client


def _user_with_transactions(migrator_url: str) -> str:
    """A user whose stored rows are the ones a sync would have left."""
    user = uuid4().hex
    with psycopg.connect(migrator_url) as conn:
        conn.execute("SELECT set_config('app.user_id', %s, true)", (user,))
        item = conn.execute(
            "INSERT INTO plaid_items (user_id, plaid_item_id, access_token_enc)"
            " VALUES (%s, 'item', 'sealed') RETURNING id",
            (user,),
        ).fetchall()[0][0]
        account = conn.execute(
            "INSERT INTO plaid_accounts (user_id, item_id, plaid_account_id, type)"
            " VALUES (%s, %s, 'account', 'credit') RETURNING id",
            (user, item),
        ).fetchall()[0][0]
        for number, (posted_on, amount, category, pending) in enumerate(TRANSACTIONS):
            conn.execute(
                "INSERT INTO plaid_transactions (user_id, account_id, plaid_transaction_id,"
                " posted_on, amount, personal_finance_category, pending)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (
                    user,
                    account,
                    f"tx-{number}",
                    date.fromisoformat(posted_on),
                    Decimal(amount),
                    category,
                    pending,
                ),
            )
    return user


def _as(make_token: MakeToken, user: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(sub=user)}"}


def test_spending_equals_the_hand_computed_figures(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    user = _user_with_transactions(migrator_url)

    response = client.post("/v1/reports/spending", headers=_as(make_token, user))

    assert response.status_code == 201, response.text
    assert response.json()["kind"] == "spending"
    assert response.json()["figures"] == SPENDING


def test_computed_report_is_stored_and_read_back(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    user = _user_with_transactions(migrator_url)
    computed = client.post("/v1/reports/spending", headers=_as(make_token, user)).json()

    read = client.get("/v1/reports/spending", headers=_as(make_token, user))

    assert read.status_code == 200
    assert read.json() == computed
    with psycopg.connect(migrator_url) as conn:
        conn.execute("SELECT set_config('app.user_id', %s, true)", (user,))
        stored = conn.execute("SELECT id::text, kind, figures FROM reports").fetchall()
    assert stored == [(computed["id"], "spending", SPENDING)]


def test_latest_computation_is_the_one_read_back(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    user = _user_with_transactions(migrator_url)
    headers = _as(make_token, user)
    client.post("/v1/reports/spending", headers=headers)
    with psycopg.connect(migrator_url) as conn:
        conn.execute("SELECT set_config('app.user_id', %s, true)", (user,))
        conn.execute("DELETE FROM plaid_transactions WHERE posted_on >= '2026-11-01'")

    latest = client.post("/v1/reports/spending", headers=headers).json()

    assert latest["figures"] == SPENDING[:3]
    assert client.get("/v1/reports/spending", headers=headers).json() == latest


def test_user_with_no_accounts_gets_an_empty_report_and_no_error(
    client: TestClient, make_token: MakeToken
) -> None:
    response = client.post("/v1/reports/spending", headers=_as(make_token, uuid4().hex))

    assert response.status_code == 201
    assert response.json()["figures"] == []


def test_report_never_computed_is_not_found(client: TestClient, make_token: MakeToken) -> None:
    response = client.get("/v1/reports/spending", headers=_as(make_token, uuid4().hex))

    assert response.status_code == 404


def test_one_users_report_is_not_read_by_another(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    user = _user_with_transactions(migrator_url)
    client.post("/v1/reports/spending", headers=_as(make_token, user))

    other = client.get("/v1/reports/spending", headers=_as(make_token, uuid4().hex))

    assert other.status_code == 404
