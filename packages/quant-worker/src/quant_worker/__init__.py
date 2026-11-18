"""The quant worker (U10): claim a unit, run every model and both selectors, upload the result.

Runs on the owner's nodes. It opens outbound connections to the worker API only, and the one
secret it holds is its worker token (I14).
"""

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import asdict
from typing import Any
from urllib.parse import urlsplit

from finance_core.quant import Bar, ModePolicy, TradeCosts, evaluate, select_winner

POLL_SECONDS = 30


class WorkerApi:
    def __init__(self, base_url: str, token: str) -> None:
        address = urlsplit(base_url)
        loopback = address.scheme == "http" and address.hostname in ("127.0.0.1", "localhost")
        if address.scheme != "https" and not loopback:
            raise ValueError("the worker API must be reached over HTTPS")
        self._base_url = base_url.rstrip("/")
        self._token = token

    def _send(self, method: str, path: str, body: object = None) -> Any:
        request = urllib.request.Request(  # noqa: S310 - the scheme is checked in __init__
            f"{self._base_url}/worker/v1{path}",
            data=None if body is None else json.dumps(body).encode(),
            method=method,
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            payload = response.read()
        return json.loads(payload) if payload else None

    def claim(self) -> dict[str, Any] | None:
        """The next unit, leased to this worker, or None when there is none."""
        unit: dict[str, Any] | None = self._send("POST", "/claim")
        return unit

    def bars(self, unit_id: str) -> list[Bar]:
        return [Bar(**row) for row in self._send("GET", f"/units/{unit_id}/bars")["bars"]]

    def upload(self, unit_id: str, result: dict[str, Any]) -> bool:
        """False when the unit already has a result or its lease is no longer this worker's."""
        try:
            self._send("POST", f"/units/{unit_id}/result", result)
        except urllib.error.HTTPError as error:
            if error.code == 409:
                return False
            raise
        return True


def run_once(api: WorkerApi) -> bool:
    """Work one unit. False when there was none to claim."""
    unit = api.claim()
    if unit is None:
        return False
    policy = ModePolicy(**unit["policy"])
    costs = TradeCosts(**unit["costs"])
    results = evaluate(api.bars(unit["unit_id"]), sector=unit["sector"], policy=policy, costs=costs)
    winners = {}
    for mode in ("stable", "aggressive"):
        winner = select_winner(results, mode, policy=policy, costs=costs)
        winners[mode] = None if winner is None else winner.model_id
    api.upload(
        unit["unit_id"], {"results": [asdict(result) for result in results], "winners": winners}
    )
    return True


def main() -> None:
    api = WorkerApi(os.environ["WORKER_API_URL"], os.environ["WORKER_TOKEN"])
    while True:
        if not run_once(api):
            time.sleep(POLL_SECONDS)
