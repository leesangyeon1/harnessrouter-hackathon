"""Pure D24 plans. Broker execution, order state, and locking live in the API."""

from __future__ import annotations

import math
from collections.abc import Mapping
from decimal import ROUND_DOWN, Decimal


def _cash(value: Decimal) -> Decimal:
    return value.quantize(Decimal(".01"), rounding=ROUND_DOWN)


def wanted_values(equity: Decimal, mode: str, positions: Mapping[str, float]) -> dict[str, Decimal]:
    if mode not in ("stable", "aggressive") or not equity.is_finite():
        raise ValueError("invalid mode or equity")
    if any(not math.isfinite(p) or not 0 <= p <= 1 for p in positions.values()):
        raise ValueError("positions must be between zero and one")
    if not positions:
        return {}
    equity = max(Decimal(0), equity)
    deploy, weight = (
        (Decimal(".5"), Decimal(".2")) if mode == "stable" else (Decimal(1), Decimal(1))
    )
    allocation = min(deploy * equity / len(positions), weight * equity)
    return {s: allocation * Decimal(str(p)) for s, p in sorted(positions.items())}


def sell_targets(
    equity: Decimal,
    mode: str,
    positions: Mapping[str, float],
    *,
    frozen_value: Decimal = Decimal(0),
) -> dict[str, Decimal]:
    """Fitted row-1 values before sells; rows 2/3 sell fully, rows 4/6 freeze."""
    wanted = wanted_values(equity, mode, positions)
    if not frozen_value.is_finite() or frozen_value < 0:
        raise ValueError("invalid frozen value")
    budget = max(Decimal(0), equity) * (Decimal(".5") if mode == "stable" else Decimal(1))
    room = max(Decimal(0), budget - frozen_value)
    total = sum(wanted.values(), Decimal(0))
    factor = min(Decimal(1), room / total) if total else Decimal(1)
    return {s: _cash(v * factor) for s, v in wanted.items()}


def targets(
    equity: Decimal,
    mode: str,
    positions: Mapping[str, float],
    *,
    held_after_sells: Decimal = Decimal(0),
    existing_winners: Mapping[str, Decimal] | None = None,
) -> dict[str, Decimal]:
    """Return post-buy row-1 values using fresh broker holdings after sells.

    No second sell is planned. Existing values may exceed their desired target
    when the first sell was rejected. Every held dollar consumes the budget.
    Differences below $1 remain in this calculation; the executor omits orders
    below $1, per D24. This function never sends an order.
    """
    wanted = wanted_values(equity, mode, positions)
    existing = existing_winners or {}
    if (
        not held_after_sells.is_finite()
        or held_after_sells < 0
        or any(not v.is_finite() or v < 0 for v in existing.values())
        or not existing.keys() <= positions.keys()
        or sum(existing.values(), Decimal(0)) > held_after_sells
    ):
        raise ValueError("invalid current holdings")
    equity = max(Decimal(0), equity)
    budget = equity * (Decimal(".5") if mode == "stable" else Decimal(1))
    room = max(Decimal(0), min(budget - held_after_sells, equity - held_after_sells))
    shortfalls = {s: max(Decimal(0), v - existing.get(s, Decimal(0))) for s, v in wanted.items()}
    total = sum(shortfalls.values(), Decimal(0))
    factor = min(Decimal(1), room / total) if total else Decimal(1)
    return {
        s: existing.get(s, Decimal(0)) + _cash(shortfall * factor)
        for s, shortfall in shortfalls.items()
    }
