"""Computed Sandbox report figures; provider payloads never pass through here."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import TypedDict

CENT = Decimal(".01")


class CardRow(TypedDict):
    label: str
    balance: Decimal | None
    purchase_apr: Decimal | None
    minimum_payment: Decimal | None
    paydown_rank: int | None


class CardReport(TypedDict):
    paydown: list[CardRow]
    best_card_by_category: dict[str, str]


class LoanRow(TypedDict):
    label: str
    balance: Decimal
    rate: Decimal
    remaining_term: int
    reference_rate: Decimal
    interest_saved: Decimal


class RefinanceReport(TypedDict):
    loans: list[LoanRow]
    not_covered: list[str]


def _money(value: Decimal) -> Decimal:
    if not value.is_finite():
        raise ValueError("nonfinite money")
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class Transaction:
    date: str
    amount: Decimal
    category: str | None
    pending: bool = False


@dataclass(frozen=True)
class Card:
    label: str
    balance: Decimal | None
    purchase_apr: Decimal | None
    minimum_payment: Decimal | None


@dataclass(frozen=True)
class Loan:
    label: str
    balance: Decimal
    rate: Decimal
    remaining_months: int
    loan_type: str


def spending(transactions: Sequence[Transaction]) -> list[dict[str, str | Decimal]]:
    grouped: dict[tuple[str, str], Decimal] = {}
    for tx in transactions:
        date.fromisoformat(tx.date)
        if not tx.amount.is_finite():
            raise ValueError("invalid transaction amount")
        if tx.pending:
            continue
        key = (tx.date[:7], tx.category or "UNCATEGORIZED")
        grouped[key] = grouped.get(key, Decimal(0)) + tx.amount
    return [
        {"month": month, "category": category, "amount": _money(value)}
        for (month, category), value in sorted(grouped.items())
    ]


def _rankable_debt(card: Card) -> bool:
    return card.balance is not None and card.balance > 0 and card.purchase_apr is not None


def card_report(cards: Sequence[Card], rewards: Mapping[str, Mapping[str, Decimal]]) -> CardReport:
    """Preserve signed/unknown figures; rank only positive known debt with known APR.

    APRs are percentages. Rewards are owned, dated table inputs, not Plaid fields.
    A negative credit balance means the lender owes the holder; it does not prove
    why the credit exists. An unknown minimum payment is not a zero payment.
    """
    if len({c.label for c in cards}) != len(cards):
        raise ValueError("card labels must be unique")
    for card in cards:
        if (
            any(
                value is not None and not value.is_finite()
                for value in (card.balance, card.minimum_payment, card.purchase_apr)
            )
            or (card.minimum_payment is not None and card.minimum_payment < 0)
            or (card.purchase_apr is not None and card.purchase_apr < 0)
        ):
            raise ValueError("invalid card figures")
    ordered = sorted(
        cards, key=lambda c: (not _rankable_debt(c), -(c.purchase_apr or Decimal(0)), c.label)
    )
    paydown: list[CardRow] = [
        {
            "label": c.label,
            "balance": None if c.balance is None else _money(c.balance),
            "purchase_apr": c.purchase_apr,
            "minimum_payment": None if c.minimum_payment is None else _money(c.minimum_payment),
            "paydown_rank": i + 1 if _rankable_debt(c) else None,
        }
        for i, c in enumerate(ordered)
    ]
    labels = {c.label for c in cards}
    best = {}
    for category, rates in sorted(rewards.items()):
        if any(not rate.is_finite() or rate < 0 for rate in rates.values()):
            raise ValueError("invalid reward rate")
        owned = [label for label in rates if label in labels]
        if owned:
            best[category] = min(owned, key=lambda label: (-rates[label], label))
    return {"paydown": paydown, "best_card_by_category": best}


def _interest(principal: Decimal, annual_rate: Decimal, months: int) -> Decimal:
    if annual_rate == 0:
        return Decimal(0)
    r = annual_rate / Decimal(1200)
    payment = principal * r / (1 - (1 + r) ** -months)
    return payment * months - principal


def refinance(
    loans: Sequence[Loan], reference_rates: Mapping[str, Decimal], *, readable_types: set[str]
) -> RefinanceReport:
    """Only include loan types proven readable by U0(a); savings exclude fees."""
    output: list[LoanRow] = []
    not_covered: set[str] = set()
    for loan in loans:
        if loan.loan_type not in readable_types or loan.loan_type not in reference_rates:
            not_covered.add(loan.loan_type)
            continue
        reference = reference_rates[loan.loan_type]
        if (
            not all(v.is_finite() for v in (loan.balance, loan.rate, reference))
            or min(loan.balance, loan.rate, reference) < 0
            or loan.remaining_months <= 0
        ):
            raise ValueError("invalid loan figures")
        saved = _interest(loan.balance, loan.rate, loan.remaining_months) - _interest(
            loan.balance, reference, loan.remaining_months
        )
        output.append(
            {
                "label": loan.label,
                "balance": _money(loan.balance),
                "rate": loan.rate,
                "remaining_term": loan.remaining_months,
                "reference_rate": reference,
                "interest_saved": _money(saved),
            }
        )
    return {"loans": output, "not_covered": sorted(not_covered)}
