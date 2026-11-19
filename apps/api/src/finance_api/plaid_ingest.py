"""Plaid ingest (U2): seed the user's Sandbox Item, and store what Plaid holds for it."""

import json
from collections.abc import Callable
from datetime import date, timedelta
from importlib.resources import files
from typing import Annotated, Any
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from finance_api.auth import current_user
from finance_api.db import tenant_transaction
from finance_api.plaid import PlaidClient, PlaidError, Row
from finance_api.sealing import SecretBox

router = APIRouter(prefix="/v1/plaid")

User = Annotated[str, Depends(current_user)]

# What Plaid documents for a product an Item cannot serve. The first kind means the Item has no
# such account, so there is nothing to hold. The second means Plaid cannot say.
NO_SUCH_ACCOUNTS = {"liabilities": "NO_LIABILITY_ACCOUNTS", "holdings": "NO_INVESTMENT_ACCOUNTS"}
CANNOT_SAY = ("PRODUCT_NOT_ENABLED", "PRODUCTS_NOT_SUPPORTED", "PRODUCT_NOT_READY")


def custom_user(today: date | None = None) -> Row:
    """The invented user this MVP runs on (DW1). Its figures are synthetic.

    The file counts each transaction back from today, so that the dates sent to Plaid are
    never in the future, which Plaid would hold as pending, and stay inside the history it
    returns.
    """
    seed = files("finance_api").joinpath("plaid_seed.json").read_text(encoding="utf-8")
    configured: Row = json.loads(seed)
    today = today or date.today()
    for account in configured["override_accounts"]:
        for transaction in account.get("transactions", []):
            day = (today - timedelta(days=transaction.pop("days_ago"))).isoformat()
            transaction["date_transacted"] = transaction["date_posted"] = day
    return configured


def _product[T](
    name: str, read: Callable[[], T], nothing: T, unavailable: dict[str, str]
) -> T | None:
    """What Plaid holds for one product: `nothing` when the Item has no such account, and None,
    with Plaid's refusal recorded, when Plaid cannot say. Any other refusal is an error."""
    try:
        return read()
    except PlaidError as refused:
        if refused.code == NO_SUCH_ACCOUNTS[name]:
            return nothing
        if refused.code in CANNOT_SAY and refused.code is not None:
            unavailable[name] = refused.code
            return None
        raise


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
    item_id, access_token = plaid.create_item(custom_user())
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
def sync(request: Request, user_id: User) -> dict[str, Any]:
    """Bring the stored rows level with Plaid.

    Returns how many rows the user now has, whether Plaid has finished preparing the Item's
    transactions, and any product Plaid could not serve, by Plaid's own code. A count of zero
    transactions means nothing final until `transactions_ready` is true.
    """
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
    unavailable: dict[str, str] = {}
    accounts = plaid.accounts(access_token)
    changed, removed, next_cursor, ready = plaid.transactions_since(access_token, cursor)
    none_owed: Row = {}
    none_held: tuple[list[Row], list[Row]] = ([], [])
    liabilities = _product(
        "liabilities", lambda: plaid.liabilities(access_token), none_owed, unavailable
    )
    held = _product("holdings", lambda: plaid.holdings(access_token), none_held, unavailable)

    with tenant_transaction(pool, user_id) as conn:
        # Two syncs of one Item both upsert its accounts first, so the second waits there until
        # the first commits. Every write is an upsert or a replacement, so it changes nothing.
        account_ids = _store_accounts(conn, user_id, item_id, accounts)
        _store_transactions(conn, user_id, account_ids, changed, removed)
        if liabilities is not None:
            _store_liabilities(conn, user_id, account_ids, liabilities)
        if held is not None:
            _store_holdings(conn, user_id, account_ids, *held)
        conn.execute(
            "UPDATE plaid_items SET transactions_cursor = %s WHERE id = %s", (next_cursor, item_id)
        )
        counts = conn.execute(
            "SELECT (SELECT count(*) FROM plaid_accounts),"
            " (SELECT count(*) FROM plaid_transactions),"
            " (SELECT count(*) FROM plaid_liabilities),"
            " (SELECT count(*) FROM plaid_holdings)"
        ).fetchall()[0]
    stored = dict(zip(("accounts", "transactions", "liabilities", "holdings"), counts, strict=True))
    return {**stored, "transactions_ready": ready, "unavailable": unavailable}


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
    conn.execute(
        "DELETE FROM plaid_liabilities WHERE NOT (account_id = ANY(%s))",
        ([account_ids[liability["account_id"]] for liability, *_ in rows],),
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
