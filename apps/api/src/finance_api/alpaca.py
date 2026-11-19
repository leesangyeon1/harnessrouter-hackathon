"""Alpaca reference and market data client (U5). Paper and data hosts only (I1).

The endpoints and fields are taken from Alpaca's documentation. None has been checked against
the service itself; U0 (b) does that.
"""

import os
import time
from collections.abc import Callable, Sequence
from datetime import date
from typing import Any

import httpx

from finance_core.quant import Bar

TRADING_HOST = "paper-api.alpaca.markets"
DATA_HOST = "data.alpaca.markets"
# Alpaca allows 200 requests a minute (F11). One every third of a second stays under that.
REQUEST_SPACING = 60 / 180
SYMBOLS_PER_REQUEST = 200
RATE_LIMIT_RETRIES = 5

Row = dict[str, Any]


class AlpacaError(Exception):
    """Alpaca refused a request. Carries the path and the status, never a credential."""


class AlpacaData:
    def __init__(
        self,
        key_id: str,
        secret_key: str,
        http: httpx.Client,
        feed: str,
        pause: Callable[[float], object] = time.sleep,
    ) -> None:
        if feed not in ("iex", "sip"):
            raise ValueError("the equity feed must be iex or sip")
        self.feed = feed
        self._headers = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret_key}
        self._http = http
        self._pause = pause

    def _get(self, host: str, path: str, params: dict[str, str]) -> Any:
        """One request under the limiter. A 429 is waited out and asked again, a few times."""
        for attempt in range(RATE_LIMIT_RETRIES + 1):
            self._pause(REQUEST_SPACING)
            response = self._http.get(f"https://{host}{path}", params=params, headers=self._headers)
            if response.status_code == 200:
                return response.json()
            if response.status_code != 429 or attempt == RATE_LIMIT_RETRIES:
                break
            self._pause(2**attempt)
        raise AlpacaError(f"Alpaca answered {path} with {response.status_code}")

    def market_date(self) -> date:
        """Today's date on the market's own clock."""
        return date.fromisoformat(self._get(TRADING_HOST, "/v2/clock", {})["timestamp"][:10])

    def trading_days(self, start: date, end: date) -> list[date]:
        days = self._get(
            TRADING_HOST, "/v2/calendar", {"start": start.isoformat(), "end": end.isoformat()}
        )
        return [date.fromisoformat(day["date"]) for day in days]

    def assets(self) -> list[Row]:
        """Every stock, ETF and crypto asset Alpaca lists, whatever its status."""
        return [
            asset
            for asset_class in ("us_equity", "crypto")
            for asset in self._get(TRADING_HOST, "/v2/assets", {"asset_class": asset_class})
        ]

    def stock_bars(self, symbols: Sequence[str], start: date, end: date) -> dict[str, list[Bar]]:
        """Split-adjusted daily bars from the feed this key is entitled to."""
        extra = {"adjustment": "split", "feed": self.feed}
        return self._bars("/v2/stocks/bars", symbols, start, end, extra)

    def crypto_bars(self, symbols: Sequence[str], start: date, end: date) -> dict[str, list[Bar]]:
        return self._bars("/v1beta3/crypto/us/bars", symbols, start, end, {})

    def _bars(
        self, path: str, symbols: Sequence[str], start: date, end: date, extra: dict[str, str]
    ) -> dict[str, list[Bar]]:
        bars: dict[str, list[Bar]] = {}
        for first in range(0, len(symbols), SYMBOLS_PER_REQUEST):
            params = {
                "symbols": ",".join(symbols[first : first + SYMBOLS_PER_REQUEST]),
                "timeframe": "1Day",
                "start": start.isoformat(),
                "end": end.isoformat(),
                "limit": "10000",
                **extra,
            }
            while True:
                page = self._get(DATA_HOST, path, params)
                for symbol, rows in page["bars"].items():
                    bars.setdefault(symbol, []).extend(
                        Bar(row["t"][:10], row["o"], row["h"], row["l"], row["c"], row["v"])
                        for row in rows
                    )
                token = page.get("next_page_token")
                if not token:
                    break
                params = params | {"page_token": token}
        return bars


def alpaca_from_env() -> AlpacaData:
    """The data client of a job. finance_api.jobs has refused any host but the paper one."""
    return AlpacaData(
        os.environ["ALPACA_API_KEY"],
        os.environ["ALPACA_SECRET_KEY"],
        httpx.Client(timeout=60),
        os.environ.get("ALPACA_FEED", "iex"),
    )
