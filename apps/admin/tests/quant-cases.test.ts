import test from "node:test";
import assert from "node:assert/strict";
import {
  QUANT_BENCHMARK_SUMMARY,
  QUANT_MODEL_LEADERBOARD,
  QUANT_PERFORMANCE_CASES,
} from "../src/lib/quant-cases-data";

test("hardcoded quant performance log has 30 cases (>25) with exact 70% loss and 30% winning", () => {
  assert.equal(QUANT_PERFORMANCE_CASES.length, 30);
  assert.ok(QUANT_PERFORMANCE_CASES.length > 25);

  assert.equal(QUANT_BENCHMARK_SUMMARY.lossCases, 21);
  assert.equal(QUANT_BENCHMARK_SUMMARY.profitCases, 9);
  assert.equal(QUANT_BENCHMARK_SUMMARY.lossRatePct, 70.0);
  assert.equal(QUANT_BENCHMARK_SUMMARY.profitRatePct, 30.0);
  assert.ok(QUANT_BENCHMARK_SUMMARY.totalNetPnlUsd < 0);
  assert.equal(QUANT_MODEL_LEADERBOARD.length, 24);
});

test("every single case specifies 22 (>=20) distinct quants, exact formulas, and cent-reconciled per-quant performance", () => {
  for (const qCase of QUANT_PERFORMANCE_CASES) {
    assert.ok(qCase.legs.length >= 20, `${qCase.caseId} must have 20+ legs`);
    const uniqueQuants = new Set(qCase.legs.map((l) => l.quantId));
    const uniqueTickers = new Set(qCase.legs.map((l) => l.ticker));
    assert.equal(uniqueQuants.size, qCase.legs.length);
    assert.equal(uniqueTickers.size, qCase.legs.length);
    assert.ok(uniqueQuants.size >= 20);
    assert.ok(uniqueTickers.size >= 20);

    const legNetSum = Number(
      qCase.legs.reduce((acc, l) => acc + l.netPnlUsd, 0).toFixed(2),
    );
    const legGrossSum = Number(
      qCase.legs.reduce((acc, l) => acc + l.grossPnlUsd, 0).toFixed(2),
    );
    const legFeeSum = Number(
      qCase.legs.reduce((acc, l) => acc + l.feeUsd, 0).toFixed(2),
    );
    assert.equal(legNetSum, qCase.netPnlUsd);
    assert.equal(legGrossSum, qCase.totalGrossPnlUsd);
    assert.equal(legFeeSum, qCase.totalFeesUsd);
    if (qCase.outcome === "PROFIT") {
      assert.ok(qCase.netPnlUsd > 0);
    } else {
      assert.ok(qCase.netPnlUsd < 0);
    }
    const ranks = new Set(qCase.legs.map((l) => l.quantRankInCase));
    assert.equal(ranks.size, 22);
    for (const leg of qCase.legs) {
      assert.ok(leg.algorithmFormula.length > 10);
      assert.ok(leg.parametersSummary.length > 5);
      assert.equal(
        Number((leg.grossPnlUsd - leg.feeUsd).toFixed(2)),
        leg.netPnlUsd,
      );
      assert.ok(leg.entryTimeUtc.endsWith("Z"));
      assert.ok(leg.exitTimeUtc.endsWith("Z"));
      assert.ok(leg.entryPrice > 0);
      assert.ok(leg.exitPrice > 0);
      assert.ok(leg.barsEvaluated >= 250);
    }
  }
});
