"""A read-back against the real Plaid Sandbox (U0 (a)).

Run it where PLAID_CLIENT_ID and PLAID_SECRET hold Sandbox credentials:

    python -m finance_api.plaid_probe

It creates one custom-user Item from plaid_seed.json, reads it back through the client the
service itself uses, and prints a report of what Plaid returned. It touches no database, and
the report holds no credential, token or Plaid identifier. The exit status is 0 when the
spending demo's path works: the Item is created, its accounts are read, and at least one
transaction arrives.
"""

import json
import time
from collections.abc import Callable

from finance_api.plaid import PlaidClient, PlaidError, Row, plaid_client_from_env
from finance_api.plaid_ingest import custom_user

# Plaid prepares an Item's transactions after it creates the Item, and says so with an update
# status. How long that takes in the Sandbox is not documented; these two numbers are assumed.
ATTEMPTS = 6
PAUSE_SECONDS = 5.0


def probe(
    plaid: PlaidClient,
    configured: Row,
    pause: Callable[[float], object] = time.sleep,
    attempts: int = ATTEMPTS,
) -> Row:
    try:
        _, access_token = plaid.create_item(configured)
    except PlaidError as refused:
        return {"seed": {"error": refused.code}, "spending_demo_ready": False}

    def accounts() -> Row:
        found = plaid.accounts(access_token)
        return {
            "count": len(found),
            "configured": len(configured["override_accounts"]),
            "kinds": sorted(f"{account['type']}/{account.get('subtype')}" for account in found),
            "without_balance": sum(a["balances"].get("current") is None for a in found),
        }

    def transactions() -> Row:
        changed: list[Row] = []
        cursor = None
        for attempt in range(1, attempts + 1):
            more, _, cursor, ready = plaid.transactions_since(access_token, cursor)
            changed += more
            if ready or attempt == attempts:
                break
            pause(PAUSE_SECONDS)
        return {
            "count": len(changed),
            "attempts": attempt,
            "ready": ready,
            "without_category": sum(t.get("personal_finance_category") is None for t in changed),
            "pending": sum(bool(t.get("pending")) for t in changed),
        }

    def liabilities() -> Row:
        return {
            kind: len(rows or []) for kind, rows in sorted(plaid.liabilities(access_token).items())
        }

    def holdings() -> Row:
        held, securities = plaid.holdings(access_token)
        return {"count": len(held), "securities": len(securities)}

    report: Row = {"seed": "ok"}
    steps = {
        "accounts": accounts,
        "transactions": transactions,
        "liabilities": liabilities,
        "holdings": holdings,
    }
    for name, read in steps.items():
        try:
            report[name] = read()
        except PlaidError as refused:
            report[name] = {"error": refused.code}
    report["spending_demo_ready"] = (
        "error" not in report["accounts"] and report["transactions"].get("count", 0) > 0
    )
    return report


def main() -> int:
    report = probe(plaid_client_from_env(), custom_user())
    print(json.dumps(report, indent=2))
    return 0 if report["spending_demo_ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
