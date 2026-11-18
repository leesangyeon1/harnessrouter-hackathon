import unittest
from dataclasses import replace
from datetime import date, timedelta
from decimal import Decimal as D

from finance_core.quant import Bar, ModePolicy
from finance_core.reports import Card, Loan, Transaction, card_report, refinance, spending
from finance_core.screening import Asset, screen
from finance_core.sizing import sell_targets, targets


def bars(move=0.001, volume=1000, count=300):
    return [
        Bar(
            str(date(2024, 1, 1) + timedelta(days=i)),
            100 * (1 + move) ** i,
            101 * (1 + move) ** i,
            99 * (1 + move) ** i,
            100 * (1 + move) ** i,
            volume,
        )
        for i in range(count)
    ]


class ScreenTests(unittest.TestCase):
    def test_missing_recent_calendar_date_is_not_replaced_with_older_bar(self):
        history = bars()
        dates = {b.date for b in history}
        gapped = history[:290] + history[291:]
        result = screen(
            [Asset("A", "us_equity")],
            {"A": gapped},
            "stock",
            cycle_dates=dates,
            as_of=history[-1].date,
        )
        self.assertEqual(result.selections, ())
        self.assertEqual(result.excluded["A"], "missing_screen_date")

    def test_stale_bar_and_future_bar_excluded(self):
        history = bars()
        result = screen(
            [Asset("A", "us_equity")], {"A": history[:-1]}, "stock", as_of=history[-1].date
        )
        self.assertEqual(result.selections, ())
        self.assertEqual(
            screen(
                [Asset("A", "us_equity")], {"A": history}, "stock", as_of=history[-2].date
            ).selected_bars["A"][-1],
            history[-2],
        )

    def test_exact_tie_uses_symbol(self):
        result = screen(
            [Asset(s, "us_equity") for s in "FEDCBA"], {s: bars() for s in "ABCDEF"}, "stock"
        )
        self.assertEqual([r.symbol for r in result.selections], ["A", "B"])

    def test_volume_gate_then_absolute_movement(self):
        assets = [Asset(symbol, "us_equity") for symbol in "ABCDEF"]
        histories = {
            s: bars(move, volume)
            for s, move, volume in [
                ("A", 0.003, 10000),
                ("B", -0.002, 100000),
                ("C", 0.0001, 100),
                ("D", 0.0001, 100),
                ("E", 0.0001, 100),
                ("F", 0.02, 1),
            ]
        }
        result = screen(assets, histories, "stock", feed="iex")
        self.assertEqual([s.symbol for s in result.selections], ["A", "B"])
        self.assertEqual(result.universe, "alpaca_us_equity")
        self.assertEqual(result.feed, "iex")
        self.assertFalse(result.market_wide)
        self.assertEqual(result.coverage["provider_listed"], 6)

    def test_watchlist_and_unavailable_assets_named(self):
        assets = [
            Asset("TLT", "us_equity"),
            Asset("IEF", "us_equity", tradable=False),
            Asset("SHY", "us_equity", fractionable=False),
            Asset("OTHER", "us_equity"),
        ]
        result = screen(assets, {"TLT": bars()}, "bond", feed="sip")
        self.assertEqual([s.symbol for s in result.selections], ["TLT"])
        self.assertIn("IEF", result.excluded)
        self.assertIn("SHY", result.excluded)
        self.assertIn("BND", result.excluded)
        self.assertEqual(result.universe, "bond_etf_list@1")

    def test_short_history_excluded_after_liquidity_ranking(self):
        result = screen([Asset("A", "us_equity")], {"A": bars(count=249)}, "stock", feed="iex")
        self.assertEqual(result.selections, ())
        self.assertEqual(result.coverage["too_few_bars"], 1)
        self.assertIn("A", result.excluded)

    def test_crypto_uses_only_cycle_dates(self):
        history = bars()
        dates = {b.date for b in history if date.fromisoformat(b.date).weekday() < 5}
        # Supply 400 calendar days so the equity-date subset is long enough.
        history = bars(count=400)
        dates = {b.date for b in history if date.fromisoformat(b.date).weekday() < 5}
        assets = [Asset("BTC/USD", "crypto"), Asset("BTC/EUR", "crypto")]
        first = screen(assets, {"BTC/USD": history}, "crypto", cycle_dates=dates)
        changed = [replace(b, volume=1000000) if b.date not in dates else b for b in history]
        self.assertEqual(first, screen(assets, {"BTC/USD": changed}, "crypto", cycle_dates=dates))
        self.assertEqual(first.feed, "alpaca_venue")
        self.assertEqual(first.coverage["not_usd"], 1)

    def test_no_history_and_duplicate_symbols(self):
        result = screen([], {}, "stock", feed="iex")
        self.assertEqual(result.selections, ())
        with self.assertRaises(ValueError):
            screen([Asset("A", "us_equity")] * 2, {}, "stock", feed="iex")


class ReportTests(unittest.TestCase):
    def test_credit_balance_is_preserved_and_has_no_paydown_rank(self):
        report = card_report(
            [Card("Credit", D("-25.23"), D(30), D(0))], {"FOOD": {"Credit": D(".03")}}
        )
        row = report["paydown"][0]
        self.assertEqual(row["balance"], D("-25.23"))
        self.assertIsNone(row["paydown_rank"])
        self.assertEqual(report["best_card_by_category"], {"FOOD": "Credit"})

    def test_unknown_minimum_is_preserved_separately_from_zero(self):
        report = card_report(
            [Card("Unknown", D(100), D(20), None), Card("Zero", D(100), D(10), D(0))], {}
        )
        self.assertIsNone(report["paydown"][0]["minimum_payment"])
        self.assertEqual(report["paydown"][1]["minimum_payment"], D("0.00"))
        self.assertEqual([row["paydown_rank"] for row in report["paydown"]], [1, 2])

    def test_only_positive_known_debts_receive_contiguous_paydown_ranks(self):
        cards = [
            Card("Zero balance", D(0), D(99), D(0)),
            Card("Credit balance", D(-10), D(80), None),
            Card("Unknown balance", None, D(60), None),
            Card("Lower APR debt", D(200), D(10), D(5)),
            Card("Higher APR debt", D(100), D(20), D(10)),
            Card("Unknown APR", D(100), None, None),
        ]
        report = card_report(cards, {})
        rows = {row["label"]: row for row in report["paydown"]}
        self.assertEqual(rows["Higher APR debt"]["paydown_rank"], 1)
        self.assertEqual(rows["Lower APR debt"]["paydown_rank"], 2)
        for label in ("Zero balance", "Credit balance", "Unknown balance", "Unknown APR"):
            self.assertIsNone(rows[label]["paydown_rank"])
        self.assertIsNone(rows["Unknown balance"]["balance"])
        self.assertEqual(len(report["paydown"]), len(cards))

    def test_invalid_card_values_remain_rejected(self):
        for card in (
            Card("A", D("NaN"), D(10), None),
            Card("A", D(100), D(-1), None),
            Card("A", D(100), None, D(-1)),
            Card("A", None, None, D("Infinity")),
        ):
            with self.subTest(card=card), self.assertRaises(ValueError):
                card_report([card], {})

    def test_spending_and_unknown_categories(self):
        txs = [
            Transaction("2024-01-01", D("10.10"), "FOOD"),
            Transaction("2024-01-02", D("4.90"), "FOOD"),
            Transaction("2024-01-03", D("-2"), "FOOD"),
            Transaction("2024-01-04", D("3"), None),
            Transaction("2024-01-05", D("999"), "FOOD", pending=True),
        ]
        self.assertEqual(
            spending(txs),
            [
                {"month": "2024-01", "category": "FOOD", "amount": D("13.00")},
                {"month": "2024-01", "category": "UNCATEGORIZED", "amount": D("3.00")},
            ],
        )
        self.assertEqual(spending([]), [])

    def test_purchase_apr_unknown_is_not_zero(self):
        cards = [
            Card("A", D(100), D("22.5"), D(10)),
            Card("B", D(200), None, D(15)),
            Card("C", D(300), D(0), D(5)),
        ]
        report = card_report(cards, {"FOOD": {"A": D(".03"), "B": D(".02")}})
        self.assertEqual([c["label"] for c in report["paydown"]], ["A", "C", "B"])
        self.assertIsNone(report["paydown"][-1]["purchase_apr"])
        self.assertIsNone(report["paydown"][-1]["paydown_rank"])
        self.assertEqual(report["best_card_by_category"], {"FOOD": "A"})

    def test_refinance_amortization_and_unproven_loan(self):
        result = refinance(
            [
                Loan("Student loan", D(1200), D(0), 12, "student"),
                Loan("Consumer loan", D(1000), D(9), 12, "consumer"),
            ],
            {"student": D(0)},
            readable_types={"student"},
        )
        self.assertEqual(result["loans"][0]["interest_saved"], D("0.00"))
        self.assertEqual(result["not_covered"], ["consumer"])
        result = refinance(
            [Loan("Student loan", D(1200), D(12), 12, "student")],
            {"student": D(6)},
            readable_types={"student"},
        )
        # Monthly payments 106.618546414... and 103.279715648...;
        # (106.618546414 - 103.279715648) * 12 = 40.065969192.
        self.assertEqual(result["loans"][0]["interest_saved"], D("40.07"))


class SizingTests(unittest.TestCase):
    def test_cycle_policy_sizes_both_sell_and_buy_plans(self):
        policy = ModePolicy(
            version=2,
            stable_deploy=0.6,
            stable_ticker_cap=0.3,
            aggressive_deploy=0.8,
            aggressive_ticker_cap=0.4,
        )
        self.assertEqual(targets(D(1000), "stable", {"A": 1}, policy=policy), {"A": D(300)})
        self.assertEqual(
            targets(D(1000), "stable", {"A": 1}, policy=policy, held_after_sells=D(500)),
            {"A": D(100)},
        )
        self.assertEqual(
            sell_targets(D(1000), "stable", {"A": 1}, frozen_value=D(500), policy=policy),
            {"A": D(100)},
        )
        self.assertEqual(targets(D(1000), "aggressive", {"A": 1}, policy=policy), {"A": D(400)})

    def test_sell_targets_fit_around_frozen_holdings(self):
        self.assertEqual(
            sell_targets(D(1000), "stable", {"A": 1}, frozen_value=D(800)), {"A": D(0)}
        )
        self.assertEqual(
            sell_targets(D(1000), "stable", {"A": 1, "B": 1}, frozen_value=D(400)),
            {"A": D(50), "B": D(50)},
        )

    def test_partly_filled_sells_consume_all_remaining_room(self):
        self.assertEqual(
            targets(
                D(1000),
                "stable",
                {"A": 1, "B": 1},
                held_after_sells=D(500),
                existing_winners={"A": D(200)},
            ),
            {"A": D(200), "B": D(0)},
        )

    def test_plan_examples(self):
        self.assertEqual(targets(D(1000), "stable", {"A": 1}), {"A": D("200.00")})
        self.assertEqual(
            targets(D(1000), "stable", {"A": 1, "B": 1, "C": 1}),
            dict.fromkeys(("A", "B", "C"), D("166.66")),
        )
        self.assertEqual(targets(D(1000), "aggressive", {"A": 0.4, "B": 1})["A"], D("200.00"))

    def test_frozen_and_existing_holdings_consume_budget(self):
        self.assertEqual(targets(D(1000), "stable", {"A": 1}, held_after_sells=D(800)), {"A": D(0)})
        self.assertEqual(
            targets(D(1000), "stable", {"A": 1}, held_after_sells=D(300)), {"A": D(200)}
        )
        self.assertEqual(
            targets(
                D(1000),
                "stable",
                {"A": 1, "B": 1},
                held_after_sells=D(400),
                existing_winners={"A": D(400)},
            ),
            {"A": D(400), "B": D(100)},
        )

    def test_no_winner_and_no_equity(self):
        self.assertEqual(targets(D(1000), "stable", {}), {})
        self.assertEqual(targets(D(-50), "stable", {"A": 1}), {"A": D(0)})
        with self.assertRaises(ValueError):
            targets(D(1000), "stable", {"A": 1.2})


if __name__ == "__main__":
    unittest.main()
