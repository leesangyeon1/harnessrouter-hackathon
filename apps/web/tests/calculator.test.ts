import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISOR_PRESETS,
  computeBalanceTransferComparison,
  computeRefinanceComparison,
} from "../src/lib/calculator";

test("balance transfer calculator produces verified payoff months, fee, and net savings", () => {
  const result = computeBalanceTransferComparison({
    balanceUsd: 2387.65,
    currentAprPct: 24.49,
    monthlyPaymentUsd: 200,
    transferFeePct: 3,
    promoAprPct: 0,
    promoMonths: 15,
    postPromoAprPct: 21.99,
    goal: "Minimize total cost",
  });
  assert.equal(result.optionCurrent.payable, true);
  assert.equal(result.optionTransfer.payable, true);
  assert.equal(result.optionTransfer.upfrontFeeUsd, "$71.63");
  assert.ok((result.optionCurrent.months ?? 0) >= (result.optionTransfer.months ?? 0));
  assert.match(result.formattedPrompt, /Calculator verification status: VERIFIED/);
});

test("refinance calculator distinguishes lower monthly payment from higher total lifetime cost when extending term", () => {
  const result = computeRefinanceComparison({
    principalUsd: 18500,
    currentAprPct: 6.8,
    remainingMonths: 36,
    newAprPct: 5.75,
    newTermMonths: 60,
    refiFeeUsd: 250,
    goal: "Compare monthly relief vs total cost",
  });
  // Extending 36m -> 60m lowers monthly payment (negative delta) yet increases total interest + fee (negative savings).
  assert.ok(result.monthlyPaymentDeltaUsd.startsWith("-$"));
  assert.ok(result.netTotalSavingsUsd.startsWith("-$"));
  assert.equal(ADVISOR_PRESETS.length, 3);
});
