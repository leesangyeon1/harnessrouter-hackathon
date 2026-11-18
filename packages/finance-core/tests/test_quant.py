import json
import math
import unittest
from dataclasses import asdict, replace
from datetime import date, timedelta

from finance_core.quant import (
    MODEL_IDS,
    MODEL_SET_VERSION,
    Bar,
    Metrics,
    ModelResult,
    ModePolicy,
    TradeCosts,
    account_step,
    backtest,
    bars_digest,
    evaluate,
    metrics,
    positions,
    select_winner,
)


def series(count=300):
    bars = []
    for i in range(count):
        close = 100 + i * 0.05 + 15 * math.sin(i / 8)
        bars.append(
            Bar(
                str(date(2024, 1, 1) + timedelta(days=i)),
                close + 0.3,
                close + 2,
                close - 2,
                close,
                1000,
            )
        )
    return bars


class QuantTests(unittest.TestCase):
    def test_bar_identity_survives_json_numeric_normalization(self):
        integer_bar = Bar("2024-01-01", 100, 101, 99, 100, 1000)
        float_bar = Bar("2024-01-01", 100.0, 101.0, 99.0, 100.0, 1000.0)
        self.assertEqual(integer_bar, float_bar)
        self.assertEqual(bars_digest([integer_bar]), bars_digest([float_bar]))
        # The API reads PostgreSQL numeric fields as floats; the worker reads JSON.
        api_wire = {
            key: float(value) if key != "date" else value
            for key, value in asdict(integer_bar).items()
        }
        restored = Bar(**json.loads(json.dumps(api_wire)))
        self.assertEqual(bars_digest([integer_bar]), bars_digest([restored]))

    def test_equivalent_date_and_zero_volume_have_one_identity(self):
        canonical = Bar("2024-01-01", 100.0, 101.0, 99.0, 100.0, 0.0)
        alternate = Bar("20240101", 100, 101, 99, 100, -0.0)
        self.assertEqual(asdict(canonical), asdict(alternate))
        self.assertEqual(bars_digest([canonical]), bars_digest([alternate]))

    def test_boolean_bar_values_are_not_numbers(self):
        for field in ("open", "high", "low", "close", "volume"):
            values = {
                "date": "2024-01-01",
                "open": 1.0,
                "high": 2.0,
                "low": 1.0,
                "close": 1.0,
                "volume": 1.0,
            }
            values[field] = True
            with self.subTest(field=field), self.assertRaises(ValueError):
                Bar(**values)

    def test_ten_models_plus_unranked_baseline(self):
        self.assertEqual(
            MODEL_IDS, ("M00", "M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M10", "M11")
        )

    def test_every_model_uses_only_prior_bars(self):
        bars = series()
        for model in MODEL_IDS:
            full = positions(bars, model)
            for cutoff in (62, 120, 210):
                changed = bars[:cutoff] + [
                    replace(
                        b,
                        open=b.open * 2,
                        high=b.high * 2,
                        low=b.low * 2,
                        close=b.close * 2,
                        volume=b.volume * 3,
                    )
                    for b in bars[cutoff:]
                ]
                with self.subTest(model=model, cutoff=cutoff):
                    self.assertEqual(full[: cutoff + 1], positions(changed, model)[: cutoff + 1])
                    self.assertEqual(full[:cutoff], positions(bars[:cutoff], model))
            self.assertEqual(full[:61], [0.0] * 61)

    def test_open_fill_and_cost(self):
        for cost, expected in ((0, -0.0625), (0.001, -0.0634375)):
            cash, qty, value, traded = account_step(1, 0, 112, 105, 1, cost)
            self.assertAlmostEqual(value - 1, expected)
            self.assertEqual(cash, 0)
            self.assertEqual(traded, 1)
        for cost, expected in ((0, -0.047619047619), (0.001, -0.048571428571)):
            _, _, value, _ = account_step(0, 1 / 105, 100, 100, 0, cost)
            self.assertAlmostEqual(value - 1, expected)

    def test_fractional_rebalance_pays_cost(self):
        self.assertEqual(account_step(50, 0.5, 200, 400, 0.5, 0)[2], 225)
        self.assertAlmostEqual(account_step(50, 0.5, 200, 400, 0.5, 0.001)[2], 224.975)
        self.assertEqual(account_step(0, 0.5, 200, 400, 1, 0.001)[3], 0)

    def test_signal_state_survives_warmup(self):
        bars = [
            Bar(
                str(date(2024, 1, 1) + timedelta(days=i)),
                100 - i * 0.1,
                102 - i * 0.1,
                98 - i * 0.1,
                100 - i * 0.1,
                100,
            )
            for i in range(80)
        ]
        self.assertEqual(positions(bars, "M04")[61], 1)
        result = backtest(bars, "M04", 0.001)
        self.assertAlmostEqual(result.daily_returns[0], -0.001)

    def test_known_trend_positions(self):
        bars = [
            Bar(str(date(2024, 1, 1) + timedelta(days=i)), 100 + i, 101 + i, 99 + i, 100 + i, 100)
            for i in range(90)
        ]
        for model in ("M00", "M01", "M02", "M03", "M07", "M08"):
            self.assertEqual(positions(bars, model)[61], 1)
        for model in ("M04", "M05", "M10", "M11"):
            self.assertEqual(positions(bars, model)[61], 0)

    def test_hand_computed_impulse_entries_and_exits(self):
        # 70 flat bars, a fall to 50, then a rise to 200. At signal day 70:
        # SMA20=97.5 < SMA50=99; RSI=0; lower Bollinger band=75.71;
        # prior Donchian low=99. At signal day 71: SMA20=102.5 > 101;
        # RSI=75; upper breakout=101. Each signal takes effect a day later.
        closes = [100.0] * 70 + [50.0, 200.0, 200.0]
        bars = [
            Bar(str(date(2024, 1, 1) + timedelta(days=i)), c, c + 1, c - 1, c, 100)
            for i, c in enumerate(closes)
        ]
        for model in ("M01", "M02", "M03", "M06", "M07"):
            self.assertEqual(positions(bars, model)[71:73], [0.0, 1.0], model)
        for model in ("M04", "M05", "M11"):
            self.assertEqual(positions(bars, model)[71:73], [1.0, 0.0], model)
        # M08: mean=.125, sum of squared deviations=8.9375, n-1=19.
        self.assertEqual(positions(bars, "M08")[71], 0)
        self.assertAlmostEqual(positions(bars, "M08")[72], 0.01 / math.sqrt(8.9375 / 19))

    def test_stochastic_enters_and_exits_using_d(self):
        bars = [
            Bar(str(date(2024, 1, 1) + timedelta(days=i)), 51, 101, 1, 51, 100) for i in range(70)
        ]
        for i, k in zip(range(59, 65), (10, 15, 20, 90, 95, 100), strict=True):
            bars[i] = replace(bars[i], close=k + 1)
        # D=15 at 61; D=(90+95+100)/3=95 at 64.
        self.assertEqual(positions(bars, "M10")[62:66], [1.0, 1.0, 1.0, 0.0])

    def test_stochastic_uses_three_k_values(self):
        for k_values, enters in (((50, 80, 10), False), ((10, 15, 20), True)):
            bars = [
                Bar(str(date(2024, 1, 1) + timedelta(days=i)), 51, 101, 1, 51, 100)
                for i in range(65)
            ]
            for i, k in zip((59, 60, 61), k_values, strict=True):
                bars[i] = replace(bars[i], close=k + 1)
            self.assertEqual(positions(bars, "M10")[62], int(enters))

    def test_metrics_include_initial_equity_for_drawdown(self):
        m = metrics([-0.1, -0.1])
        self.assertAlmostEqual(m.net_return, -0.19)
        self.assertAlmostEqual(m.max_drawdown, 0.19)
        self.assertIsNone(m.sharpe)
        self.assertIsNone(metrics([0, 0]).sharpe)

    def result(self, model, net, sharpe, drawdown=0.1, confirmation=0.05):
        return ModelResult(
            model,
            MODEL_SET_VERSION,
            1,
            "bars-hash",
            Metrics(net, sharpe, drawdown),
            Metrics(confirmation, 1, 0.1),
            1.0,
        )

    def test_two_modes_and_ties(self):
        results = [
            self.result("M01", 0.2, 1),
            self.result("M02", 0.1, 2),
            self.result("M00", 0.9, 9),
        ]
        self.assertEqual(select_winner(results, "aggressive").model_id, "M01")
        self.assertEqual(select_winner(results, "stable").model_id, "M02")
        results.append(self.result("M03", 0.3, 3, drawdown=0.25))
        self.assertEqual(select_winner(results, "stable").model_id, "M02")
        self.assertEqual(
            select_winner(
                [self.result("M02", 0.2, 1), self.result("M01", 0.2, 1)], "stable"
            ).model_id,
            "M01",
        )

    def test_failed_confirmation_does_not_fall_back(self):
        for confirmation in (-0.01, 0):
            results = [
                self.result("M01", 0.2, 2, confirmation=confirmation),
                self.result("M02", 0.1, 1),
            ]
            for mode in ("stable", "aggressive"):
                self.assertIsNone(select_winner(results, mode))
        self.assertIsNone(select_winner([self.result("M01", 0, None)], "stable"))

    def test_mixed_versions_refused(self):
        base = self.result("M01", 0.2, 2)
        for bad in (
            replace(base, model_set_version="other"),
            replace(base, policy_version=2),
            replace(base, bars_hash="other"),
        ):
            with self.assertRaises(ValueError):
                select_winner([base, replace(bad, model_id="M02")], "stable")

    def test_pinned_policy_and_costs_are_inputs(self):
        policy = ModePolicy(version=2, stable_max_drawdown=0.3, confirmation_bars=20)
        costs = TradeCosts(stock=0.005, bond=0.006, crypto=0.007)
        results = evaluate(series(), policy=policy, costs=costs)
        self.assertTrue(all(r.policy_version == 2 and r.cost_per_side == 0.005 for r in results))
        self.assertTrue(
            all(r.policy_hash == policy.digest and r.costs_hash == costs.digest for r in results)
        )
        # A 25% drawdown is allowed by this cycle's policy, independent of default v1.
        winner = replace(
            results[1], selection=Metrics(0.2, 2, 0.25), confirmation=Metrics(0.1, 1, 0.1)
        )
        self.assertEqual(select_winner([winner], "stable", policy=policy, costs=costs), winner)
        with self.assertRaises(ValueError):
            select_winner([winner], "stable")
        with self.assertRaises(ValueError):
            evaluate(series(), policy_version=1, policy=policy)
        expected = backtest(series(), "M01", 0.005)
        self.assertEqual(results[1].selection, metrics(expected.daily_returns[:-20]))
        self.assertEqual(results[1].confirmation, metrics(expected.daily_returns[-20:]))

    def test_same_version_with_changed_values_or_costs_is_refused(self):
        bars = series()
        base = evaluate(bars)
        changed_policy = evaluate(bars, policy=ModePolicy(stable_max_drawdown=0.3))
        changed_cost = evaluate(bars, costs=TradeCosts(stock=0.002))
        for changed in (changed_policy, changed_cost):
            with self.assertRaises(ValueError):
                select_winner([base[1], changed[2]], "stable")
        with self.assertRaises(ValueError):
            select_winner([replace(base[1], cost_per_side=0.009)], "stable")

    def test_invalid_pinned_settings_are_refused(self):
        for settings in (
            {"version": 0},
            {"version": True},
            {"stable_max_drawdown": float("nan")},
            {"stable_deploy": 2},
            {"confirmation_bars": 0},
        ):
            with self.assertRaises(ValueError):
                ModePolicy(**settings)
        for cost in (-0.001, 1, float("inf")):
            with self.assertRaises(ValueError):
                TradeCosts(stock=cost)
        with self.assertRaises(ValueError):
            evaluate(series(), policy=ModePolicy(confirmation_bars=250))

    def test_evaluation_is_reproducible_and_requires_250_bars(self):
        bars = series()
        first = evaluate(bars)
        self.assertEqual(len(first), 11)
        self.assertEqual(
            json.dumps([asdict(x) for x in first], sort_keys=True),
            json.dumps([asdict(x) for x in evaluate(bars)], sort_keys=True),
        )
        with self.assertRaises(ValueError):
            evaluate(bars[:249])

    def test_invalid_bars_and_costs_rejected(self):
        with self.assertRaises(ValueError):
            Bar("2024-01-01", 0, 100, 1, 50, 100)
        with self.assertRaises(ValueError):
            positions(series()[::-1], "M01")
        with self.assertRaises(ValueError):
            account_step(1, 0, 100, 100, 1, -0.001)


if __name__ == "__main__":
    unittest.main()
