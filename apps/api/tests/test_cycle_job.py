"""U5: market ingest and the sector screen, the cycle job's first step (I4, I7, I12).

Alpaca is answered here as its documentation describes it. No response shape below has been
seen from the real service; U0 (b) is what checks them.
"""

import json
import statistics
from collections.abc import Callable, Iterator
from datetime import date, timedelta
from decimal import Decimal
from itertools import pairwise
from typing import Any

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg_pool import ConnectionPool

from finance_api import alpaca, jobs, market_ingest
from finance_api.alpaca import AlpacaData, alpaca_from_env
from finance_api.app import create_app
from finance_api.auth import IdTokenVerifier
from finance_api.market_ingest import run_cycle
from finance_api.plaid import PlaidClient
from finance_api.sealing import SecretBox
from finance_core.quant import MODEL_SET_VERSION, ModePolicy, TradeCosts

MakeToken = Callable[..., str]

TODAY = date(2026, 11, 18)  # a Wednesday
KEY_ID = "key-id"
SECRET_KEY = "alpaca-secret"  # noqa: S105

BOND_LIST = ["TLT", "IEF", "SHY", "LQD", "HYG", "BND", "TIP"]

# symbol: price, daily volume, daily swing. Dollar volume is price x volume.
STOCKS = {
    "AAA": (100.0, 9e6, 0.030),
    "BBB": (100.0, 8e6, 0.020),
    "CCC": (100.0, 7e6, 0.010),
    "DDD": (100.0, 6e6, 0.001),
    "EEE": (100.0, 5e6, 0.050),  # heavily traded, but only 120 bars
    **{f"F{number:02d}": (10.0, 1e4, 0.040) for number in range(1, 9)},
}
BONDS = {
    "TLT": (90.0, 5e6, 0.012),
    "IEF": (95.0, 4e6, 0.006),
    "SHY": (82.0, 3e6, 0.001),
    "LQD": (108.0, 2e6, 0.005),
    "HYG": (77.0, 1e6, 0.004),
    "BND": (72.0, 9e6, 0.003),  # not fractionable
    "TIP": (110.0, 9e6, 0.003),  # not active
}
CRYPTO = {
    "BTC/USD": (60000.0, 1000.0, 0.020),
    "ETH/USD": (3000.0, 10000.0, 0.030),
    "SOL/USD": (150.0, 1000.0, 0.050),
    "DOGE/USD": (0.1, 1e5, 0.080),
    "BTC/USDT": (60000.0, 5000.0, 0.020),  # not quoted in USD
}
# Thirteen eligible stocks give K = 5: AAA to EEE by dollar volume. EEE lacks the bars, DDD
# moves least, so three remain, biggest mover first. Five eligible bond ETFs give K = 2, and
# four USD pairs give K = 2.
SELECTED = {
    "stock": ["AAA", "BBB", "CCC"],
    "bond": ["TLT", "IEF"],
    "crypto": ["ETH/USD", "BTC/USD"],
}


def _weekdays(until: date, count: int) -> list[date]:
    days: list[date] = []
    day = until
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day)
        day -= timedelta(days=1)
    return days[::-1]


def _bar(day: date, before: float, close: float, volume: float) -> dict[str, Any]:
    return {
        "t": f"{day.isoformat()}T05:00:00Z",
        "o": before,
        "h": max(before, close) * 1.001,
        "l": min(before, close) * 0.999,
        "c": close,
        "v": volume,
    }


def _series(days: list[date], price: float, volume: float, swing: float) -> list[dict[str, Any]]:
    bars = []
    close = price
    for number, day in enumerate(days):
        before, close = close, price * (1 + swing * (1 if number % 2 else -1))
        bars.append(_bar(day, before, close, volume))
    return bars


def _asset(symbol: str, asset_class: str = "us_equity", **changes: Any) -> dict[str, Any]:
    asset = {
        "symbol": symbol,
        "class": asset_class,
        "status": "active",
        "tradable": True,
        "fractionable": True,
        "exchange": "CRYPTO" if asset_class == "crypto" else "NYSE",
    }
    return asset | changes


class FakeAlpaca:
    """Assets, a weekday calendar and daily bars, answered as Alpaca documents them."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.rate_limited = 0
        self.symbols_per_page: int | None = None
        self.pauses: list[float] = []
        yesterday = TODAY - timedelta(days=1)
        trading = _weekdays(yesterday, 600)
        every_day = [yesterday - timedelta(days=back) for back in range(840)][::-1]
        self.assets = [
            *(_asset(symbol) for symbol in STOCKS),
            _asset("INA", status="inactive"),
            _asset("NOT", tradable=False),
            _asset("NFR", fractionable=False),
            *(_asset(symbol) for symbol in BOND_LIST if symbol not in ("BND", "TIP")),
            _asset("BND", fractionable=False),
            _asset("TIP", status="inactive"),
            *(_asset(symbol, "crypto") for symbol in CRYPTO),
        ]
        self.bars: dict[str, list[dict[str, Any]]] = {}
        for symbol, (price, volume, swing) in (STOCKS | BONDS).items():
            days = trading[-120:] if symbol == "EEE" else trading
            self.bars[symbol] = _series(days, price, volume, swing)
        for symbol, (price, volume, swing) in CRYPTO.items():
            self.bars[symbol] = _series(every_day, price, volume, swing)
        # A weekend frenzy that would put DOGE on top if weekend bars counted.
        for bar in self.bars["DOGE/USD"]:
            if date.fromisoformat(bar["t"][:10]).weekday() >= 5:
                bar["v"] = 1e13

    def client(self, feed: str = "iex") -> AlpacaData:
        http = httpx.Client(transport=httpx.MockTransport(self._answer))
        return AlpacaData(KEY_ID, SECRET_KEY, http, feed, pause=self.pauses.append)

    def calls(self, path: str) -> list[dict[str, str]]:
        return [params for _, called, params in self.requests if called == path]

    def _answer(self, request: httpx.Request) -> httpx.Response:
        host, path, params = request.url.host, request.url.path, dict(request.url.params)
        self.requests.append((host, path, params))
        assert request.headers["APCA-API-KEY-ID"] == KEY_ID
        assert request.headers["APCA-API-SECRET-KEY"] == SECRET_KEY
        if self.rate_limited > 0:
            self.rate_limited -= 1
            return httpx.Response(429, json={"message": "too many requests"})
        if (host, path) == ("paper-api.alpaca.markets", "/v2/assets"):
            wanted = [a for a in self.assets if a["class"] == params["asset_class"]]
            return httpx.Response(200, json=wanted)
        if (host, path) == ("paper-api.alpaca.markets", "/v2/clock"):
            return httpx.Response(200, json={"timestamp": f"{TODAY.isoformat()}T08:00:00-05:00"})
        if (host, path) == ("paper-api.alpaca.markets", "/v2/calendar"):
            start, end = date.fromisoformat(params["start"]), date.fromisoformat(params["end"])
            days = [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
            return httpx.Response(
                200, json=[{"date": day.isoformat()} for day in days if day.weekday() < 5]
            )
        assert host == "data.alpaca.markets", (host, path)
        assert params["timeframe"] == "1Day"
        if path == "/v2/stocks/bars":
            assert params["adjustment"] == "split"
            assert params["feed"] in ("iex", "sip")
        else:
            assert path == "/v1beta3/crypto/us/bars"
        symbols = params["symbols"].split(",")
        page = int(params.get("page_token", "0"))
        size = self.symbols_per_page or len(symbols)
        served = symbols[page * size : (page + 1) * size]
        more = (page + 1) * size < len(symbols)
        bars = {
            symbol: [
                bar
                for bar in self.bars.get(symbol, [])
                if params["start"] <= bar["t"][:10] <= params["end"]
            ]
            for symbol in served
        }
        token = str(page + 1) if more else None
        return httpx.Response(200, json={"bars": bars, "next_page_token": token})


@pytest.fixture
def market() -> FakeAlpaca:
    return FakeAlpaca()


CYCLE_TABLES = (
    "work_units",
    "model_results",
    "winners",
    "selected_bars",
    "selections",
    "screening_figures",
)


def _forget_cycles(migrator_url: str, cycle_date: date | None = TODAY) -> None:
    """Remove the cycle of one date with everything stored for it, or every cycle."""
    which = "TRUE" if cycle_date is None else "cycle_date = %(day)s"
    with psycopg.connect(migrator_url) as conn:
        for table in CYCLE_TABLES:
            conn.execute(
                f"DELETE FROM {table} WHERE cycle_id IN"  # noqa: S608
                f" (SELECT id FROM cycles WHERE {which})",
                {"day": cycle_date},
            )
        conn.execute(f"DELETE FROM cycles WHERE {which}", {"day": cycle_date})  # noqa: S608


@pytest.fixture(autouse=True)
def no_cycle_for_today(migrator_url: str) -> None:
    _forget_cycles(migrator_url)


def _run(cycle_url: str, market: FakeAlpaca, feed: str = "iex", today: date = TODAY) -> str:
    with psycopg.connect(cycle_url) as conn:
        return run_cycle(conn, market.client(feed), today)


def _query(
    migrator_url: str, query: str, params: tuple[Any, ...] = (TODAY,)
) -> list[tuple[Any, ...]]:
    with psycopg.connect(migrator_url) as conn:
        return conn.execute(query.encode(), params).fetchall()


def _selections(migrator_url: str) -> dict[str, list[str]]:
    """Selected symbols per sector, biggest mover first."""
    rows = _query(
        migrator_url,
        "SELECT s.sector, s.symbol FROM selections s"
        " JOIN screening_figures f USING (cycle_id, sector, symbol)"
        " JOIN cycles c ON c.id = s.cycle_id WHERE c.cycle_date = %s"
        " ORDER BY s.sector, f.mean_abs_move DESC",
    )
    selected: dict[str, list[str]] = {}
    for sector, symbol in rows:
        selected.setdefault(sector, []).append(symbol)
    return selected


def _screens(migrator_url: str) -> dict[str, dict[str, Any]]:
    ((screens,),) = _query(migrator_url, "SELECT screens FROM cycles WHERE cycle_date = %s")
    stored: dict[str, dict[str, Any]] = screens
    return stored


def test_selected_tickers_equal_the_hand_computed_set_in_each_sector(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    outcome = _run(cycle_url, market)

    assert outcome == "created"
    assert _selections(migrator_url) == SELECTED


def test_cycle_pins_the_model_set_the_policy_and_the_costs(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    _run(cycle_url, market)

    ((model_set, policy_version, costs, policy),) = _query(
        migrator_url,
        "SELECT c.model_set_version, c.policy_version, c.costs, p.policy FROM cycles c"
        " JOIN mode_policies p ON p.version = c.policy_version WHERE c.cycle_date = %s",
    )
    assert model_set == MODEL_SET_VERSION
    assert policy_version >= 1
    assert TradeCosts(**costs) == TradeCosts()
    assert ModePolicy(**policy).version == policy_version


def test_each_selected_ticker_has_its_bars_and_one_work_unit(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    _run(cycle_url, market)

    units = _query(
        migrator_url,
        "SELECT u.symbol FROM work_units u JOIN cycles c ON c.id = u.cycle_id"
        " WHERE c.cycle_date = %s ORDER BY u.symbol",
    )
    assert [symbol for (symbol,) in units] == sorted(
        symbol for symbols in SELECTED.values() for symbol in symbols
    )
    stored = _query(
        migrator_url,
        "SELECT b.bar_date::text, b.open, b.high, b.low, b.close, b.volume FROM selected_bars b"
        " JOIN cycles c ON c.id = b.cycle_id WHERE c.cycle_date = %s AND b.symbol = 'AAA'"
        " ORDER BY b.bar_date",
    )
    served = market.bars["AAA"][-500:]
    assert len(stored) == 500
    assert stored == [
        (bar["t"][:10], *(Decimal(repr(float(bar[key]))) for key in "ohlcv")) for bar in served
    ]


def test_screening_figures_equal_the_hand_computed_values_without_rounding(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    _run(cycle_url, market)

    window = market.bars["AAA"][-21:]
    closes = [bar["c"] for bar in window]
    dollar_volume = statistics.fmean(bar["c"] * bar["v"] for bar in window[1:])
    move = statistics.fmean(abs(later / earlier - 1) for earlier, later in pairwise(closes))
    stored = _query(
        migrator_url,
        "SELECT f.mean_dollar_volume, f.mean_abs_move FROM screening_figures f"
        " JOIN cycles c ON c.id = f.cycle_id WHERE c.cycle_date = %s AND f.symbol = 'AAA'",
    )
    assert stored == [(Decimal(repr(dollar_volume)), Decimal(repr(move)))]


def test_symbol_without_the_bars_the_models_need_is_excluded_and_named(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    _run(cycle_url, market)

    assert _screens(migrator_url)["stock"]["excluded"]["EEE"] == "too_few_bars"
    assert "EEE" not in _selections(migrator_url)["stock"]


def test_bond_etf_that_is_not_active_tradable_and_fractionable_is_excluded_and_named(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    _run(cycle_url, market)

    excluded = _screens(migrator_url)["bond"]["excluded"]
    assert (excluded["TIP"], excluded["BND"]) == ("not_active", "not_fractionable")


def test_crypto_bar_on_a_day_that_is_not_a_cycle_day_changes_no_selection(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    _run(cycle_url, market)

    served = [bar for bar in market.bars["DOGE/USD"] if bar["v"] == 1e13]
    assert served, "the weekend bars were never offered, so the check proves nothing"
    assert _selections(migrator_url)["crypto"] == SELECTED["crypto"]


def test_same_inputs_give_the_same_stored_screen(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    figures = (
        "SELECT f.sector, f.symbol, f.mean_dollar_volume, f.mean_abs_move"
        " FROM screening_figures f JOIN cycles c ON c.id = f.cycle_id"
        " WHERE c.cycle_date = %s ORDER BY 1, 2"
    )
    _run(cycle_url, market)
    first = (_query(migrator_url, figures), _selections(migrator_url), _screens(migrator_url))
    _forget_cycles(migrator_url)

    _run(cycle_url, FakeAlpaca())

    again = (_query(migrator_url, figures), _selections(migrator_url), _screens(migrator_url))
    assert again == first


@pytest.mark.parametrize("feed", ["iex", "sip"])
def test_every_screen_carries_its_universe_and_feed_and_no_market_wide_label(
    cycle_url: str, migrator_url: str, market: FakeAlpaca, feed: str
) -> None:
    _run(cycle_url, market, feed)

    screens = _screens(migrator_url)
    labels = {sector: (screen["universe"], screen["feed"]) for sector, screen in screens.items()}
    assert labels == {
        "stock": ("alpaca_us_equity", feed),
        "bond": ("bond_etf_list@1", feed),
        "crypto": ("alpaca_crypto_usd", "alpaca_venue"),
    }
    assert {call["feed"] for call in market.calls("/v2/stocks/bars")} == {feed}
    stored = json.dumps(screens).lower()
    assert "market" not in stored
    assert "complete" not in stored


def test_coverage_figures_equal_the_counts_in_the_asset_list_used(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    _run(cycle_url, market)

    equities = [asset for asset in market.assets if asset["class"] == "us_equity"]
    coverage = _screens(migrator_url)["stock"]["coverage"]
    assert coverage["provider_listed"] == len(equities) == 23
    assert coverage["not_active"] == sum(a["status"] != "active" for a in equities) == 2
    assert coverage["not_tradable"] == sum(not a["tradable"] for a in equities) == 1
    assert coverage["not_fractionable"] == sum(not a["fractionable"] for a in equities) == 2
    assert coverage["not_on_list"] == 5
    assert coverage["eligible"] == len(STOCKS) == 13
    assert (coverage["liquidity_ranked"], coverage["too_few_bars"], coverage["selected"]) == (
        5,
        1,
        3,
    )
    listed = _query(migrator_url, "SELECT count(*) FROM assets", ())
    assert listed == [(len(market.assets),)]


def test_sector_with_no_usable_symbol_yields_no_ticker_and_the_others_continue(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    for asset in market.assets:
        if asset["class"] == "crypto":
            asset["tradable"] = False

    outcome = _run(cycle_url, market)

    assert outcome == "created"
    selected = _selections(migrator_url)
    assert "crypto" not in selected
    assert (selected["stock"], selected["bond"]) == (SELECTED["stock"], SELECTED["bond"])
    assert _screens(migrator_url)["crypto"]["coverage"]["selected"] == 0


def test_second_start_for_the_same_date_creates_no_second_cycle(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    _run(cycle_url, market)
    asked = len(market.requests)

    outcome = _run(cycle_url, market)

    assert outcome == "exists"
    assert len(market.requests) == asked
    assert _query(migrator_url, "SELECT count(*) FROM cycles WHERE cycle_date = %s") == [(1,)]


def test_day_the_market_is_closed_gets_no_cycle(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    saturday = TODAY + timedelta(days=3)

    outcome = _run(cycle_url, market, today=saturday)

    assert outcome == "not a trading day"
    with psycopg.connect(migrator_url) as conn:
        cycles = conn.execute("SELECT count(*) FROM cycles WHERE cycle_date = %s", (saturday,))
        assert cycles.fetchall() == [(0,)]


def test_rate_limited_pull_is_delayed_and_loses_no_symbol(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    market.rate_limited = 3

    outcome = _run(cycle_url, market)

    assert outcome == "created"
    assert _selections(migrator_url) == SELECTED
    assert sum(pause >= 1 for pause in market.pauses) == 3


def test_pull_stays_under_the_providers_limit(cycle_url: str, market: FakeAlpaca) -> None:
    _run(cycle_url, market)

    assert len(market.pauses) == len(market.requests)
    assert min(market.pauses) >= 60 / 200


def test_endless_rate_limiting_ends_the_run_and_stores_nothing(
    cycle_url: str, migrator_url: str, market: FakeAlpaca
) -> None:
    market.rate_limited = 10_000

    with pytest.raises(alpaca.AlpacaError):
        _run(cycle_url, market)

    assert _query(migrator_url, "SELECT count(*) FROM cycles WHERE cycle_date = %s") == [(0,)]
    assert len(market.requests) < 20


def test_symbols_are_pulled_in_batches_and_pages_without_losing_any(
    cycle_url: str, migrator_url: str, market: FakeAlpaca, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(alpaca, "SYMBOLS_PER_REQUEST", 4)
    market.symbols_per_page = 3

    _run(cycle_url, market)

    assert _selections(migrator_url) == SELECTED
    assert max(len(call["symbols"].split(",")) for call in market.calls("/v2/stocks/bars")) == 4
    assert any("page_token" in call for call in market.calls("/v2/stocks/bars"))


@pytest.fixture
def client(
    api_url: str, verifier: IdTokenVerifier, no_plaid: PlaidClient, secret_box: SecretBox
) -> Iterator[TestClient]:
    app = create_app(ConnectionPool(api_url, open=False), verifier, no_plaid, secret_box)
    with TestClient(app) as test_client:
        yield test_client


def test_latest_cycle_is_returned_with_universe_feed_coverage_and_named_exclusions(
    cycle_url: str, market: FakeAlpaca, client: TestClient, make_token: MakeToken
) -> None:
    _run(cycle_url, market)

    response = client.get("/v1/cycles/latest", headers={"Authorization": f"Bearer {make_token()}"})

    assert response.status_code == 200, response.text
    cycle = response.json()
    assert cycle["cycle_date"] == TODAY.isoformat()
    assert cycle["model_set_version"] == MODEL_SET_VERSION
    stock = cycle["sectors"]["stock"]
    assert (stock["universe"], stock["feed"]) == ("alpaca_us_equity", "iex")
    assert stock["coverage"]["provider_listed"] == 23
    assert [row["symbol"] for row in stock["selections"]] == SELECTED["stock"]
    assert Decimal(stock["selections"][0]["mean_dollar_volume"]) > 0
    assert stock["excluded"] == {"EEE": "too_few_bars"}
    assert cycle["sectors"]["bond"]["excluded"] == {
        "BND": "not_fractionable",
        "TIP": "not_active",
    }
    assert "market" not in response.text.lower()


def test_latest_cycle_is_not_found_before_any_cycle(
    client: TestClient, make_token: MakeToken, migrator_url: str
) -> None:
    _forget_cycles(migrator_url, None)

    response = client.get("/v1/cycles/latest", headers={"Authorization": f"Bearer {make_token()}"})

    assert response.status_code == 404


def test_unknown_feed_is_refused_at_start(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALPACA_API_KEY", KEY_ID)
    monkeypatch.setenv("ALPACA_SECRET_KEY", SECRET_KEY)
    monkeypatch.setenv("ALPACA_FEED", "otc")

    with pytest.raises(ValueError, match="iex or sip"):
        alpaca_from_env()


def test_job_entry_point_creates_the_cycle_and_names_it(
    cycle_url: str, migrator_url: str, market: FakeAlpaca, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(market_ingest, "alpaca_from_env", market.client)

    with psycopg.connect(cycle_url) as conn:
        produced = market_ingest.run_job(conn)

    assert [(produced,)] == _query(
        migrator_url, "SELECT id::text FROM cycles WHERE cycle_date = %s"
    )


def test_scheduled_command_runs_the_ingest_as_the_cycle_role(
    cycle_url: str, migrator_url: str, market: FakeAlpaca, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(market_ingest, "alpaca_from_env", market.client)

    jobs.run_job("market-ingest", cycle_url)

    assert _query(migrator_url, "SELECT count(*) FROM cycles WHERE cycle_date = %s") == [(1,)]
    assert _selections(migrator_url) == SELECTED


def test_seeded_policy_and_bond_list_are_the_plans_version_one(migrator_url: str) -> None:
    ((policy,),) = _query(migrator_url, "SELECT policy FROM mode_policies WHERE version = 1", ())
    bonds = _query(migrator_url, "SELECT symbol FROM bond_etf_list WHERE version = 1", ())

    assert ModePolicy(**policy) == ModePolicy()
    assert sorted(symbol for (symbol,) in bonds) == sorted(BOND_LIST)
