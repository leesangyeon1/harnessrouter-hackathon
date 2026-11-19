"""Market ingest and the sector screen (U5): the first step of a cycle (D27).

Run by `python -m finance_api.jobs market-ingest`, as the finance_cycle role. It reads the asset
list and daily bars from Alpaca, screens each sector with finance_core, and stores the cycle:
its screening figures, labels and coverage, its selections, their bars, and one work unit per
selected ticker for the owner's nodes.
"""

import logging
from dataclasses import asdict
from datetime import date, timedelta

import psycopg
from psycopg.types.json import Jsonb

from finance_api.alpaca import AlpacaData, alpaca_from_env
from finance_api.db import exact
from finance_core.quant import DEFAULT_COSTS, MODEL_SET_VERSION, Bar
from finance_core.screening import Asset, ScreenResult, screen

logger = logging.getLogger(__name__)

# Calendar days that hold the 500 trading days the models use (D16), with room to spare.
HISTORY_DAYS = 800
SECTORS = ("stock", "bond", "crypto")
# A symbol left out for want of bars is named, in every sector (D23).
BAR_REASONS = ("too_few_bars", "missing_screen_date")


def run_job(conn: psycopg.Connection) -> str | None:
    """The job's entry point. Returns the id of today's cycle, when there is one."""
    alpaca = alpaca_from_env()
    today = alpaca.market_date()
    logger.info("market ingest for %s: %s", today, run_cycle(conn, alpaca, today))
    cycle = conn.execute("SELECT id FROM cycles WHERE cycle_date = %s", (today,)).fetchone()
    return None if cycle is None else str(cycle[0])


def run_cycle(conn: psycopg.Connection, alpaca: AlpacaData, today: date) -> str:
    """Create the cycle of `today`. Returns "created", "exists" or "not a trading day"."""
    if conn.execute("SELECT 1 FROM cycles WHERE cycle_date = %s", (today,)).fetchone():
        return "exists"
    days = alpaca.trading_days(today - timedelta(days=HISTORY_DAYS), today)
    if today not in days:
        return "not a trading day"
    earlier = [day for day in days if day < today]
    as_of, window_start, history_start = earlier[-1], earlier[-21], earlier[-500]
    cycle_dates = {day.isoformat() for day in earlier}

    listed = alpaca.assets()
    assets = [
        Asset(a["symbol"], a["class"], a["status"] == "active", a["tradable"], a["fractionable"])
        for a in listed
    ]
    bond_rows = conn.execute(
        "SELECT version, symbol FROM bond_etf_list"
        " WHERE version = (SELECT max(version) FROM bond_etf_list) ORDER BY symbol"
    ).fetchall()
    bond_version, bond_list = bond_rows[0][0], [symbol for _, symbol in bond_rows]

    def screened(sector: str, histories: dict[str, list[Bar]]) -> ScreenResult:
        return screen(
            assets,
            histories,
            sector,
            feed=alpaca.feed,
            bond_etfs=bond_list,
            bond_list_version=bond_version,
            cycle_dates=cycle_dates,
            as_of=as_of.isoformat(),
        )

    results: dict[str, ScreenResult] = {}
    for sector in SECTORS:
        pull = alpaca.crypto_bars if sector == "crypto" else alpaca.stock_bars
        # With no bars at all, the rule leaves out every symbol it would otherwise rank for
        # want of bars. Those are the symbols worth pulling.
        rankable = sorted(
            symbol
            for symbol, reason in screened(sector, {}).excluded.items()
            if reason == "too_few_bars"
        )
        recent = pull(rankable, window_start, as_of)
        first = screened(sector, recent)
        most_traded = [row.symbol for row in first.ranked[: first.coverage["liquidity_ranked"]]]
        results[sector] = screened(sector, recent | pull(most_traded, history_start, as_of))

    screens = {
        sector: {
            "universe": result.universe,
            "feed": result.feed,
            "coverage": result.coverage,
            "excluded": {
                symbol: reason
                for symbol, reason in sorted(result.excluded.items())
                if reason in BAR_REASONS or (sector == "bond" and symbol in bond_list)
            },
        }
        for sector, result in results.items()
    }
    with conn.transaction():
        policy = conn.execute("SELECT max(version) FROM mode_policies").fetchall()[0][0]
        created = conn.execute(
            "INSERT INTO cycles (cycle_date, model_set_version, policy_version, costs, screens)"
            " VALUES (%s, %s, %s, %s, %s) ON CONFLICT (cycle_date) DO NOTHING RETURNING id",
            (today, MODEL_SET_VERSION, policy, Jsonb(asdict(DEFAULT_COSTS)), Jsonb(screens)),
        ).fetchone()
        if created is None:
            return "exists"
        cycle_id = created[0]
        with conn.cursor() as cursor:
            # The assets table is the list this cycle was screened on.
            cursor.execute("DELETE FROM assets")
            cursor.executemany(
                "INSERT INTO assets (asset_class, symbol, status, tradable, fractionable, exchange)"
                " VALUES (%s, %s, %s, %s, %s, %s)",
                [
                    (
                        a["class"],
                        a["symbol"],
                        a["status"],
                        a["tradable"],
                        a["fractionable"],
                        a.get("exchange"),
                    )
                    for a in listed
                ],
            )
            for sector, result in results.items():
                cursor.executemany(
                    "INSERT INTO screening_figures"
                    " (cycle_id, sector, symbol, mean_dollar_volume, mean_abs_move)"
                    " VALUES (%s, %s, %s, %s, %s)",
                    [
                        (
                            cycle_id,
                            sector,
                            row.symbol,
                            exact(row.mean_dollar_volume),
                            exact(row.mean_absolute_move),
                        )
                        for row in result.ranked
                    ],
                )
                selected = [(cycle_id, row.symbol) for row in result.selections]
                cursor.executemany(
                    "INSERT INTO selections (cycle_id, sector, symbol) VALUES (%s, %s, %s)",
                    [(cycle_id, sector, symbol) for _, symbol in selected],
                )
                cursor.executemany(
                    "INSERT INTO selected_bars"
                    " (cycle_id, symbol, bar_date, open, high, low, close, volume)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    [
                        (
                            cycle_id,
                            symbol,
                            date.fromisoformat(bar.date),
                            exact(bar.open),
                            exact(bar.high),
                            exact(bar.low),
                            exact(bar.close),
                            exact(bar.volume),
                        )
                        for symbol, bars in result.selected_bars.items()
                        for bar in bars
                    ],
                )
                cursor.executemany(
                    "INSERT INTO work_units (cycle_id, symbol) VALUES (%s, %s)", selected
                )
    return "created"
