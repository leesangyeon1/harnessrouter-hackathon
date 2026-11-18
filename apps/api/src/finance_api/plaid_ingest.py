"""Plaid ingest (U2): seed the user's Sandbox Item, and store what Plaid holds for it."""

import json
from datetime import date
from importlib.resources import files
from typing import Annotated, Any
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from finance_api.auth import current_user
from finance_api.db import tenant_transaction
from finance_api.plaid import PlaidClient, Row
from finance_api.sealing import SecretBox

router = APIRouter(prefix="/v1/plaid")

User = Annotated[str, Depends(current_user)]


def _custom_user() -> Row:
    """The invented user this MVP runs on (DW1). Its figures are synthetic."""
    seed = files("finance_api").joinpath("plaid_seed.json").read_text(encoding="utf-8")
    custom_user: Row = json.loads(seed)
    return custom_user


@router.post("/seed", status_code=status.HTTP_201_CREATED)
def seed(request: Request, user_id: User) -> dict[str, str]:
    """Create the caller's Sandbox Item and store its access token sealed. One Item per user."""
    pool: ConnectionPool = request.app.state.pool
    plaid: PlaidClient = request.app.state.plaid
    box: SecretBox = request.app.state.box
    already = HTTPException(status.HTTP_409_CONFLICT, "the Sandbox Item already exists")
    with tenant_transaction(pool, user_id) as conn:
        if conn.execute("SELECT 1 FROM plaid_items").fetchone() is not None:
            raise already
    item_id, access_token = plaid.create_item(_custom_user())
    try:
        with tenant_transaction(pool, user_id) as conn:
            conn.execute(
                "INSERT INTO plaid_items (user_id, plaid_item_id, access_token_enc)"
                " VALUES (%s, %s, %s)",
                (user_id, item_id, box.seal(access_token)),
            )
    except psycopg.errors.UniqueViolation as raced:
        raise already from raced
    return {"status": "seeded"}


@router.post("/sync")
def sync(request: Request, user_id: User) -> dict[str, int]:
    """Bring the stored rows level with Plaid. Returns how many rows the user now has."""
    pool: ConnectionPool = request.app.state.pool
    plaid: PlaidClient = request.app.state.plaid
    box: SecretBox = request.app.state.box
    with tenant_transaction(pool, user_id) as conn:
        item = conn.execute(
            "SELECT id, access_token_enc, transactions_cursor FROM plaid_items"
        ).fetchone()
    if item is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "seed the Sandbox Item first")
    item_id, sealed, cursor = item
    access_token = box.open(sealed)

    # Everything is read before anything is written, so a failed read stores nothing.
    accounts = plaid.accounts(access_token)
    changed, removed, next_cursor = plaid.transactions_since(access_token, cursor)
    liabilities = plaid.liabilities(access_token)
    holdings, securities = plaid.holdings(access_token)

    with tenant_transaction(pool, user_id) as conn:
        # Two syncs of one Item both upsert its accounts first, so the second waits there until
        # the first commits. Every write is an upsert or a replacement, so it changes nothing.
        account_ids = _store_accounts(conn, user_id, item_id, accounts)
        _store_transactions(conn, user_id, account_ids, changed, removed)
        _store_liabilities(conn, user_id, account_ids, liabilities)
        _store_holdings(conn, user_id, account_ids, holdings, securities)
        conn.execute(
            "UPDATE plaid_items SET transactions_cursor = %s WHERE id = %s", (next_cursor, item_id)
        )
        counts = conn.execute(
            "SELECT (SELECT count(*) FROM plaid_accounts),"
            " (SELECT count(*) FROM plaid_transactions),"
            " (SELECT count(*) FROM plaid_liabilities),"
            " (SELECT count(*) FROM plaid_holdings)"
        ).fetchall()[0]
    return dict(zip(("accounts", "transactions", "liabilities", "holdings"), counts, strict=True))


def _day(value: str | None) -> date | None:
    return None if value is None else date.fromisoformat(value)


def _store_accounts(
    conn: psycopg.Connection, user_id: str, item_id: UUID, accounts: list[Row]
) -> dict[str, UUID]:
    """Upsert the accounts. Returns our id for each of Plaid's account ids."""
    ids: dict[str, UUID] = {}
    for account in accounts:
        balances = account["balances"]
        stored = conn.execute(
            "INSERT INTO plaid_accounts (user_id, item_id, plaid_account_id, name, type, subtype,"
            " current_balance, iso_currency_code)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
            " ON CONFLICT (user_id, plaid_account_id) DO UPDATE SET name = EXCLUDED.name,"
            " type = EXCLUDED.type, subtype = EXCLUDED.subtype,"
            " current_balance = EXCLUDED.current_balance,"
            " iso_currency_code = EXCLUDED.iso_currency_code"
            " RETURNING id",
            (
                user_id,
                item_id,
                account["account_id"],
                account.get("name"),
                account["type"],
                account.get("subtype"),
                balances.get("current"),
                balances.get("iso_currency_code"),
            ),
        ).fetchall()
        ids[account["account_id"]] = stored[0][0]
    return ids


def _store_transactions(
    conn: psycopg.Connection,
    user_id: str,
    account_ids: dict[str, UUID],
    changed: list[Row],
    removed: list[str],
) -> None:
    for transaction in changed:
        category = transaction.get("personal_finance_category")
        conn.execute(
            "INSERT INTO plaid_transactions (user_id, account_id, plaid_transaction_id, posted_on,"
            " amount, name, personal_finance_category, pending)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)"
            " ON CONFLICT (user_id, plaid_transaction_id) DO UPDATE SET"
            " account_id = EXCLUDED.account_id, posted_on = EXCLUDED.posted_on,"
            " amount = EXCLUDED.amount, name = EXCLUDED.name,"
            " personal_finance_category = EXCLUDED.personal_finance_category,"
            " pending = EXCLUDED.pending",
            (
                user_id,
                account_ids[transaction["account_id"]],
                transaction["transaction_id"],
                _day(transaction["date"]),
                transaction["amount"],
                transaction.get("name"),
                None if category is None else category["primary"],
                transaction["pending"],
            ),
        )
    conn.execute("DELETE FROM plaid_transactions WHERE plaid_transaction_id = ANY(%s)", (removed,))


def _store_liabilities(
    conn: psycopg.Connection, user_id: str, account_ids: dict[str, UUID], liabilities: Row
) -> None:
    """Credit cards and student loans. Where Plaid returns a `loan`-type account's rate is not
    known (F19), so that kind is not stored; the refinance report names it as not covered."""
    rows: list[tuple[Any, ...]] = []
    for card in liabilities.get("credit") or []:
        aprs = [
            {"apr_type": apr["apr_type"], "apr_percentage": str(apr["apr_percentage"])}
            for apr in card.get("aprs") or []
        ]
        rows.append((card, "credit", Jsonb(aprs), None, None))
    for loan in liabilities.get("student") or []:
        rows.append(
            (
                loan,
                "student",
                None,
                loan.get("interest_rate_percentage"),
                _day(loan.get("expected_payoff_date")),
            )
        )
    for liability, kind, aprs_json, interest_rate, maturity_on in rows:
        conn.execute(
            "INSERT INTO plaid_liabilities (user_id, account_id, kind, aprs,"
            " last_statement_balance, minimum_payment_amount, next_payment_due_on,"
            " interest_rate, maturity_on)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
            " ON CONFLICT (user_id, account_id) DO UPDATE SET kind = EXCLUDED.kind,"
            " aprs = EXCLUDED.aprs, last_statement_balance = EXCLUDED.last_statement_balance,"
            " minimum_payment_amount = EXCLUDED.minimum_payment_amount,"
            " next_payment_due_on = EXCLUDED.next_payment_due_on,"
            " interest_rate = EXCLUDED.interest_rate, maturity_on = EXCLUDED.maturity_on",
            (
                user_id,
                account_ids[liability["account_id"]],
                kind,
                aprs_json,
                liability.get("last_statement_balance"),
                liability.get("minimum_payment_amount"),
                _day(liability.get("next_payment_due_date")),
                interest_rate,
                maturity_on,
            ),
        )


def _store_holdings(
    conn: psycopg.Connection,
    user_id: str,
    account_ids: dict[str, UUID],
    holdings: list[Row],
    securities: list[Row],
) -> None:
    """Replace the holdings: one Plaid no longer reports is no longer held."""
    tickers = {security["security_id"]: security.get("ticker_symbol") for security in securities}
    conn.execute("DELETE FROM plaid_holdings")
    for holding in holdings:
        conn.execute(
            "INSERT INTO plaid_holdings (user_id, account_id, security_id, ticker, quantity,"
            " institution_value) VALUES (%s, %s, %s, %s, %s, %s)",
            (
                user_id,
                account_ids[holding["account_id"]],
                holding["security_id"],
                tickers.get(holding["security_id"]),
                holding["quantity"],
                holding["institution_value"],
            ),
        )
