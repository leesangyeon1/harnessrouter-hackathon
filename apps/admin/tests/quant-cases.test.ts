import test from "node:test";
import assert from "node:assert/strict";
import {
  QUANT_BENCHMARK_SUMMARY,
  QUANT_PERFORMANCE_CASES,
} from "../src/lib/quant-cases-data";

test("hardcoded quant performance log has 30 cases (>25) with exact 70% profit and 30% loss", () => {
  assert.equal(QUANT_PERFORMANCE_CASES.length, 30);
  assert.ok(QUANT_PERFORMANCE_CASES.length > 25);

  assert.equal(QUANT_BENCHMARK_SUMMARY.profitCases, 21);
  assert.equal(QUANT_BENCHMARK_SUMMARY.lossCases, 9);
  assert.equal(QUANT_BENCHMARK_SUMMARY.profitRatePct, 70.0);
  assert.equal(QUANT_BENCHMARK_SUMMARY.lossRatePct, 30.0);
  assert.ok(QUANT_BENCHMARK_SUMMARY.totalNetPnlUsd > 0);
});

test("every single quant case contains 22 (>=20) distinct quants and 22 (>=20) distinct tickers with exact P&L sum", () => {
  for (const qCase of QUANT_PERFORMANCE_CASES) {
    assert.ok(qCase.legs.length >= 20, `${qCase.caseId} must have 20+ legs`);
    const uniqueQuants = new Set(qCase.legs.map((l) => l.quantId));
    const uniqueTickers = new Set(qCase.legs.map((l) => l.ticker));
    assert.equal(uniqueQuants.size, qCase.legs.length);
    assert.equal(uniqueTickers.size, qCase.legs.length);
    assert.ok(uniqueQuants.size >= 20);
    assert.ok(uniqueTickers.size >= 20);

    const legSum = Number(
      qCase.legs.reduce((acc, l) => acc + l.netPnlUsd, 0).toFixed(2),
    );
    assert.equal(legSum, qCase.netPnlUsd);
    if (qCase.outcome === "PROFIT") {
      assert.ok(qCase.netPnlUsd > 0);
    } else {
      assert.ok(qCase.netPnlUsd < 0);
    }
    for (const leg of qCase.legs) {
      assert.ok(leg.entryTimeUtc.endsWith("Z"));
      assert.ok(leg.exitTimeUtc.endsWith("Z"));
      assert.ok(leg.entryPrice > 0);
      assert.ok(leg.exitPrice > 0);
      assert.ok(leg.barsEvaluated >= 250);
    }
  }
});
