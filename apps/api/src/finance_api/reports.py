"""Report engine, API side (U3): figures computed from the caller's stored rows (I2).

Spending only. The card and refinance reports wait on decisions the plan does not make: how a
stored card is labelled and matched to a rewards row, what the rate tables hold, and which loan
types U0 (a) finds readable.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from finance_api.auth import current_user
from finance_api.db import tenant_transaction
from finance_core.reports import Transaction, spending

router = APIRouter(prefix="/v1/reports")

User = Annotated[str, Depends(current_user)]


def _report(report_id: Any, computed_at: Any, figures: Any) -> dict[str, Any]:
    return {
        "id": str(report_id),
        "kind": "spending",
        "computed_at": computed_at.isoformat(),
        "figures": figures,
    }


@router.post("/spending", status_code=status.HTTP_201_CREATED)
def compute_spending(request: Request, user_id: User) -> dict[str, Any]:
    """Spending by month and category from the stored transactions, stored as a new report."""
    pool: ConnectionPool = request.app.state.pool
    with tenant_transaction(pool, user_id) as conn:
        transactions = [
            Transaction(posted_on.isoformat(), amount, category, pending)
            for posted_on, amount, category, pending in conn.execute(
                "SELECT posted_on, amount, personal_finance_category, pending"
                " FROM plaid_transactions"
            )
        ]
        # Amounts travel as decimal strings: a JSON number would round them.
        figures = [
            {"month": line["month"], "category": line["category"], "amount": str(line["amount"])}
            for line in spending(transactions)
        ]
        report_id, computed_at = conn.execute(
            "INSERT INTO reports (user_id, kind, figures) VALUES (%s, 'spending', %s)"
            " RETURNING id, computed_at",
            (user_id, Jsonb(figures)),
        ).fetchall()[0]
    return _report(report_id, computed_at, figures)


@router.get("/spending")
def latest_spending(request: Request, user_id: User) -> dict[str, Any]:
    pool: ConnectionPool = request.app.state.pool
    with tenant_transaction(pool, user_id) as conn:
        latest = conn.execute(
            "SELECT id, computed_at, figures FROM reports WHERE kind = 'spending'"
            " ORDER BY computed_at DESC, id LIMIT 1"
        ).fetchone()
    if latest is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no spending report has been computed")
    return _report(*latest)
