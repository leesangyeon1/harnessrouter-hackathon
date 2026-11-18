"""Plaid Sandbox client (U2). The Sandbox is the only Plaid host this service talks to (I1).

The endpoints and fields are taken from Plaid's documentation. None has been checked against
the Sandbox itself; U0 (a) does that.
"""

import json
import os
from decimal import Decimal
from typing import Any

import httpx

SANDBOX_HOST = "sandbox.plaid.com"
SANDBOX_INSTITUTION = "ins_109508"

Row = dict[str, Any]


class PlaidError(Exception):
    """Plaid refused a request. Carries the path and Plaid's error code, never a credential."""

    def __init__(self, path: str, status: int, code: str | None) -> None:
        super().__init__(f"Plaid answered {path} with {status} ({code})")
        self.code = code


def _error_code(response: httpx.Response) -> str | None:
    try:
        answer = response.json()
    except ValueError:
        return None
    code = answer.get("error_code") if isinstance(answer, dict) else None
    return code if isinstance(code, str) else None


class PlaidClient:
    def __init__(self, client_id: str, secret: str, http: httpx.Client) -> None:
        self._client_id = client_id
        self._secret = secret
        self._http = http

    def _post(self, path: str, body: Row) -> Row:
        response = self._http.post(
            f"https://{SANDBOX_HOST}{path}",
            json={"client_id": self._client_id, "secret": self._secret, **body},
        )
        if response.status_code != 200:
            raise PlaidError(path, response.status_code, _error_code(response))
        # Money stays decimal: a float would not survive the trip into a numeric column.
        answer: Row = json.loads(response.content, parse_float=Decimal)
        return answer

    def create_item(self, custom_user: Row) -> tuple[str, str]:
        """A new Sandbox Item holding the custom user. Returns its item id and access token."""
        created = self._post(
            "/sandbox/public_token/create",
            {
                "institution_id": SANDBOX_INSTITUTION,
                "initial_products": ["transactions", "liabilities", "investments"],
                "options": {
                    "override_username": "user_custom",
                    "override_password": json.dumps(custom_user),
                },
            },
        )
        item = self._post("/item/public_token/exchange", {"public_token": created["public_token"]})
        return item["item_id"], item["access_token"]

    def accounts(self, access_token: str) -> list[Row]:
        accounts: list[Row] = self._post("/accounts/get", {"access_token": access_token})[
            "accounts"
        ]
        return accounts

    def transactions_since(
        self, access_token: str, cursor: str | None
    ) -> tuple[list[Row], list[str], str]:
        """Every change after the cursor: added or modified, removed ids, and the next cursor."""
        changed: list[Row] = []
        removed: list[str] = []
        while True:
            body = {"access_token": access_token} | ({} if cursor is None else {"cursor": cursor})
            page = self._post("/transactions/sync", body)
            changed += [*page["added"], *page["modified"]]
            removed += [gone["transaction_id"] for gone in page["removed"]]
            cursor = page["next_cursor"]
            if not page["has_more"]:
                return changed, removed, cursor

    def liabilities(self, access_token: str) -> Row:
        liabilities: Row = self._post("/liabilities/get", {"access_token": access_token})[
            "liabilities"
        ]
        return liabilities

    def holdings(self, access_token: str) -> tuple[list[Row], list[Row]]:
        """The Item's holdings and the securities they name."""
        answer = self._post("/investments/holdings/get", {"access_token": access_token})
        return answer["holdings"], answer["securities"]


def plaid_client_from_env() -> PlaidClient:
    host = os.environ.get("PLAID_HOST", SANDBOX_HOST)
    if host != SANDBOX_HOST:
        raise ValueError(f"PLAID_HOST names {host}; only {SANDBOX_HOST} may be used")
    return PlaidClient(
        os.environ["PLAID_CLIENT_ID"], os.environ["PLAID_SECRET"], httpx.Client(timeout=30)
    )
