"""Qualified, reproducible Alpaca-universe screening (D23), never market-wide."""

from __future__ import annotations

import math
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise

from .quant import Bar, _validate_bars

BOND_ETFS = ("TLT", "IEF", "SHY", "LQD", "HYG", "BND", "TIP")


@dataclass(frozen=True)
class Asset:
    symbol: str
    asset_class: str
    active: bool = True
    tradable: bool = True
    fractionable: bool = True


@dataclass(frozen=True)
class ScreenRow:
    symbol: str
    mean_dollar_volume: float
    mean_absolute_move: float


@dataclass(frozen=True)
class ScreenResult:
    sector: str
    universe: str
    feed: str
    coverage: dict[str, int]
    ranked: tuple[ScreenRow, ...]
    selections: tuple[ScreenRow, ...]
    excluded: dict[str, str]
    selected_bars: dict[str, tuple[Bar, ...]]
    market_wide: bool = False


def screen(
    assets: Sequence[Asset],
    histories: Mapping[str, Sequence[Bar]],
    sector: str,
    *,
    feed: str = "iex",
    bond_etfs: Sequence[str] = BOND_ETFS,
    bond_list_version: int = 1,
    cycle_dates: set[str] | None = None,
    as_of: str | None = None,
) -> ScreenResult:
    """Supply split-adjusted history through t-1, and broker calendar dates.

    Crypto must be filtered to the same equity calendar as the cycle. Feed is
    the entitlement actually observed by ingestion, not a promised capability.
    """
    if sector not in ("stock", "bond", "crypto"):
        raise ValueError("unknown sector")
    if sector == "crypto" and cycle_dates is None:
        raise ValueError("crypto screening requires equity cycle dates")
    if sector != "crypto" and feed not in ("iex", "sip"):
        raise ValueError("equity feed must be iex or sip")
    if len({a.symbol for a in assets}) != len(assets):
        raise ValueError("duplicate asset symbols")
    asset_class = "crypto" if sector == "crypto" else "us_equity"
    provider = [a for a in assets if a.asset_class == asset_class]
    coverage = dict.fromkeys(
        (
            "provider_listed",
            "not_active",
            "not_tradable",
            "not_fractionable",
            "not_on_list",
            "not_usd",
            "too_few_bars",
            "missing_screen_date",
            "eligible",
            "liquidity_ranked",
            "selected",
        ),
        0,
    )
    coverage["provider_listed"] = len(provider)
    excluded: dict[str, str] = {}
    ranked: list[ScreenRow] = []
    usable: dict[str, tuple[Bar, ...]] = {}
    bond_set = set(bond_etfs)
    if sector == "bond":
        for missing in sorted(bond_set - {a.symbol for a in provider}):
            excluded[missing] = "not_listed"
    for asset in provider:
        reason = None
        if not asset.active:
            reason = "not_active"
        elif not asset.tradable:
            reason = "not_tradable"
        elif sector != "crypto" and not asset.fractionable:
            reason = "not_fractionable"
        elif (sector == "bond" and asset.symbol not in bond_set) or (
            sector == "stock" and asset.symbol in bond_set
        ):
            reason = "not_on_list"
        elif sector == "crypto" and not asset.symbol.endswith("/USD"):
            reason = "not_usd"
        if reason:
            excluded[asset.symbol] = reason
            coverage[reason] += 1
            continue
        coverage["eligible"] += 1
        history = histories.get(asset.symbol, ())
        _validate_bars(history)
        history = tuple(
            b
            for b in history
            if (cycle_dates is None or b.date in cycle_dates) and (as_of is None or b.date <= as_of)
        )
        if len(history) < 21 or (as_of is not None and history[-1].date != as_of):
            excluded[asset.symbol] = "too_few_bars"
            coverage["too_few_bars"] += 1
            continue
        window = history[-21:]
        if cycle_dates is not None:
            end = as_of or max(cycle_dates, default="")
            expected = sorted(d for d in cycle_dates if d <= end)[-21:]
            if [b.date for b in window] != expected:
                excluded[asset.symbol] = "missing_screen_date"
                coverage["missing_screen_date"] += 1
                continue
        row = ScreenRow(
            asset.symbol,
            statistics.fmean(b.close * b.volume for b in window[1:]),
            statistics.fmean(abs(b.close / a.close - 1) for a, b in pairwise(window)),
        )
        ranked.append(row)
        usable[asset.symbol] = history[-500:]
    ranked.sort(key=lambda r: (-r.mean_dollar_volume, r.symbol))
    k = min(100, math.ceil(len(ranked) / 3))
    coverage["liquidity_ranked"] = k
    candidates = []
    for row in ranked[:k]:
        if len(usable[row.symbol]) < 250:
            excluded[row.symbol] = "too_few_bars"
            coverage["too_few_bars"] += 1
        else:
            candidates.append(row)
    candidates.sort(key=lambda r: (-r.mean_absolute_move, r.symbol))
    selected = tuple(candidates[:3])
    coverage["selected"] = len(selected)
    universe = {
        "stock": "alpaca_us_equity",
        "bond": f"bond_etf_list@{bond_list_version}",
        "crypto": "alpaca_crypto_usd",
    }[sector]
    return ScreenResult(
        sector,
        universe,
        "alpaca_venue" if sector == "crypto" else feed,
        coverage,
        tuple(ranked),
        selected,
        excluded,
        {r.symbol: usable[r.symbol] for r in selected},
    )
