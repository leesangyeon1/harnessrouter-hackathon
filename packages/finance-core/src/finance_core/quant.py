"""Daily-bar models and simulated accounts, following plan D9/D16/D22.

Positions at index t read only bars[:t]. Bar 62 is index 61. Stateful
indicators run during warmup; the simulated account starts at bar 62.
"""

from __future__ import annotations

import hashlib
import json
import math
import statistics
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import date
from itertools import pairwise

MODEL_SET_VERSION = "daily-v1"
MODEL_IDS = ("M00", "M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M10", "M11")


@dataclass(frozen=True)
class Bar:
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float

    def __post_init__(self) -> None:
        date.fromisoformat(self.date)
        values = (self.open, self.high, self.low, self.close, self.volume)
        if not all(math.isfinite(v) for v in values):
            raise ValueError("bar fields must be finite")
        if min(values[:4]) <= 0 or self.volume < 0:
            raise ValueError("prices must be positive and volume nonnegative")
        if self.high < max(self.open, self.close, self.low) or self.low > min(
            self.open, self.close
        ):
            raise ValueError("inconsistent bar high/low")


@dataclass(frozen=True)
class Metrics:
    net_return: float
    sharpe: float | None
    max_drawdown: float


@dataclass(frozen=True)
class Backtest:
    daily_returns: tuple[float, ...]
    values: tuple[float, ...]
    traded_notional: tuple[float, ...]


@dataclass(frozen=True)
class ModelResult:
    model_id: str
    model_set_version: str
    policy_version: int
    bars_hash: str
    selection: Metrics
    confirmation: Metrics
    next_position: float


def _validate_bars(bars: Sequence[Bar]) -> None:
    if any(a.date >= b.date for a, b in pairwise(bars)):
        raise ValueError("bars must have unique ascending dates")


def _ema(values: Sequence[float], span: int) -> list[float]:
    output: list[float] = []
    alpha = 2 / (span + 1)
    for value in values:
        output.append(value if not output else alpha * value + (1 - alpha) * output[-1])
    return output


def _signal_positions(bars: Sequence[Bar], model_id: str) -> list[float]:
    """Return next-day signals after each observed bar (before warmup mask)."""
    closes = [b.close for b in bars]
    ema12, ema26 = _ema(closes, 12), _ema(closes, 26)
    macd = [a - b for a, b in zip(ema12, ema26, strict=True)]
    signal = _ema(macd, 9)
    state = 0.0
    output: list[float] = []
    k_values: list[float] = []
    for s, bar in enumerate(bars):
        entry = exit_ = False
        p = 0.0
        if model_id == "M00":
            p = 1.0
        elif model_id == "M01" and s >= 49:
            p = float(
                statistics.fmean(closes[s - 19 : s + 1]) > statistics.fmean(closes[s - 49 : s + 1])
            )
        elif model_id == "M02":
            p = float(ema12[s] > ema26[s])
        elif model_id == "M03":
            p = float(macd[s] > signal[s])
        elif model_id == "M04" and s >= 14:
            changes = [closes[j] - closes[j - 1] for j in range(s - 13, s + 1)]
            gain = statistics.fmean(max(0, x) for x in changes)
            loss = statistics.fmean(max(0, -x) for x in changes)
            rsi = 100 if loss == 0 else 100 - 100 / (1 + gain / loss)
            entry, exit_ = rsi < 30, rsi > 50
        elif model_id == "M05" and s >= 19:
            window = closes[s - 19 : s + 1]
            mean, sigma = statistics.fmean(window), statistics.pstdev(window)
            entry, exit_ = bar.close < mean - 2 * sigma, bar.close >= mean
        elif model_id == "M06" and s >= 20:
            entry = bar.close > max(b.high for b in bars[s - 20 : s])
            exit_ = bar.close < min(b.low for b in bars[s - 10 : s])
        elif model_id in ("M07", "M08") and s >= 60:
            p = float(bar.close > closes[s - 60])
            if p and model_id == "M08":
                returns = [closes[j] / closes[j - 1] - 1 for j in range(s - 19, s + 1)]
                v = statistics.stdev(returns)
                p = min(1.0, 0.01 / v) if v else 1.0
        elif model_id == "M10" and s >= 13:
            high = max(b.high for b in bars[s - 13 : s + 1])
            low = min(b.low for b in bars[s - 13 : s + 1])
            k_values.append(100 * (bar.close - low) / (high - low) if high != low else 50)
            if len(k_values) >= 3:
                d = statistics.fmean(k_values[-3:])
                entry, exit_ = d < 20, d > 80
        elif model_id == "M11" and s >= 5:
            p = float(bar.close < closes[s - 5])
        if model_id in ("M04", "M05", "M06", "M10"):
            if exit_:
                state = 0.0
            elif entry:
                state = 1.0
            p = state
        output.append(p)
    return output


def positions(bars: Sequence[Bar], model_id: str) -> list[float]:
    _validate_bars(bars)
    if model_id not in MODEL_IDS:
        raise ValueError("unknown model")
    signals = _signal_positions(bars, model_id)
    return [0.0 if t < 61 else signals[t - 1] for t in range(len(bars))]


def account_step(
    cash: float,
    quantity: float,
    open_price: float,
    close_price: float,
    position: float,
    cost: float,
) -> tuple[float, float, float, float]:
    """Rebalance at open; return cash, quantity, close value, traded notional."""
    if not all(math.isfinite(v) for v in (cash, quantity, open_price, close_price, position, cost)):
        raise ValueError("nonfinite account input")
    if (
        cash < 0
        or quantity < 0
        or min(open_price, close_price) <= 0
        or not 0 <= position <= 1
        or not 0 <= cost < 1
    ):
        raise ValueError("invalid account input")
    held = quantity * open_price
    target = position * (cash + held)
    delta = target - held
    if delta > 0:
        cash -= delta
        quantity += delta * (1 - cost) / open_price
    elif delta < 0:
        quantity += delta / open_price
        cash -= delta * (1 - cost)
    return max(0.0, cash), max(0.0, quantity), cash + quantity * close_price, abs(delta)


def backtest(bars: Sequence[Bar], model_id: str, cost: float) -> Backtest:
    ps = positions(bars, model_id)
    cash, quantity, previous = 1.0, 0.0, 1.0
    returns, values, traded = [], [], []
    for t in range(61, len(bars)):
        bar = bars[t]
        cash, quantity, value, trade = account_step(
            cash, quantity, bar.open, bar.close, ps[t], cost
        )
        returns.append(value / previous - 1)
        values.append(value)
        traded.append(trade)
        previous = value
    return Backtest(tuple(returns), tuple(values), tuple(traded))


def metrics(returns: Sequence[float]) -> Metrics:
    if any(not math.isfinite(r) or r < -1 for r in returns):
        raise ValueError("invalid daily return")
    value, peak, drawdown = 1.0, 1.0, 0.0
    for r in returns:
        value *= 1 + r
        peak = max(peak, value)
        drawdown = max(drawdown, 1 - value / peak)
    sd = statistics.stdev(returns) if len(returns) >= 2 else 0
    sharpe = statistics.fmean(returns) / sd * math.sqrt(252) if sd else None
    return Metrics(value - 1, sharpe, drawdown)


def bars_digest(bars: Sequence[Bar]) -> str:
    return hashlib.sha256(
        json.dumps(
            [asdict(b) for b in bars], sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def evaluate(
    bars: Sequence[Bar], *, sector: str = "stock", policy_version: int = 1
) -> list[ModelResult]:
    _validate_bars(bars)
    if len(bars) < 250:
        raise ValueError("at least 250 bars required")
    if sector not in ("stock", "bond", "crypto") or policy_version != 1:
        raise ValueError("unknown sector or policy version")
    bars = bars[-500:]
    digest = bars_digest(bars)
    cost = 0.0025 if sector == "crypto" else 0.001
    results = []
    for model_id in MODEL_IDS:
        result = backtest(bars, model_id, cost)
        next_position = _signal_positions(bars, model_id)[-1]
        results.append(
            ModelResult(
                model_id,
                MODEL_SET_VERSION,
                policy_version,
                digest,
                metrics(result.daily_returns[:-60]),
                metrics(result.daily_returns[-60:]),
                next_position,
            )
        )
    return results


def select_winner(results: Sequence[ModelResult], mode: str) -> ModelResult | None:
    if mode not in ("stable", "aggressive"):
        raise ValueError("unknown mode")
    identities = {(r.model_set_version, r.policy_version, r.bars_hash) for r in results}
    if len(identities) > 1 or any(
        r.model_set_version != MODEL_SET_VERSION or r.policy_version != 1 for r in results
    ):
        raise ValueError("results must share pinned versions and bars")
    if len({r.model_id for r in results}) != len(results) or any(
        r.model_id not in MODEL_IDS for r in results
    ):
        raise ValueError("duplicate or unknown model")
    for result in results:
        for measure in (result.selection, result.confirmation):
            if not math.isfinite(measure.net_return) or not 0 <= measure.max_drawdown <= 1:
                raise ValueError("invalid metrics")
            if measure.sharpe is not None and not math.isfinite(measure.sharpe):
                raise ValueError("invalid Sharpe")
        if not math.isfinite(result.next_position) or not 0 <= result.next_position <= 1:
            raise ValueError("invalid position")
    eligible = [
        r
        for r in results
        if r.model_id != "M00"
        and (
            mode == "aggressive"
            or (r.selection.sharpe is not None and r.selection.max_drawdown <= 0.2)
        )
    ]
    if not eligible:
        return None
    if mode == "aggressive":
        winner = min(eligible, key=lambda r: (-r.selection.net_return, r.model_id))
    else:
        winner = min(eligible, key=lambda r: (-(r.selection.sharpe or 0), r.model_id))
    return winner if winner.confirmation.net_return > 0 else None
