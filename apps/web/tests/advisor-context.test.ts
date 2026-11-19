import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ADVISOR_SCENARIOS } from "../src/lib/calculator";
import { advisorSnapshot } from "../src/lib/advisor-context-server";
import {
  advisorContextPayload,
  advisorWebRequest,
  canonicalJson,
  validAdvisorSnapshot,
} from "../src/lib/advisor-context";

test("each public scenario binds its goal, terms and calculator evidence to one canonical identity", () => {
  for (const scenario of ADVISOR_SCENARIOS) {
    const snapshot = advisorSnapshot(scenario.id)!;
    assert.equal(snapshot.payload.comparison.goal, scenario.inputs.goal);
    assert.equal(snapshot.payload.scenario_id, scenario.id);
    assert.equal(snapshot.payload.scenario_version, "advisor-demo-v1");
    assert.equal(
      snapshot.payload.calculator_evidence.version,
      "monthly-cents-v1",
    );
    assert.equal(
      snapshot.sha256,
      createHash("sha256")
        .update(canonicalJson(snapshot.payload))
        .digest("hex"),
    );
    assert.equal(validAdvisorSnapshot(snapshot, scenario.id), true);
    assert.equal(validAdvisorSnapshot(snapshot, "different-scenario"), false);
  }
  assert.equal(advisorSnapshot("../../profile"), null);
});
test("projection exposes only synthetic overview fields and rejects added private data", () => {
  const snapshot = advisorSnapshot("balance-transfer")!;
  for (const account of snapshot.payload.webpage_sample_overview.accounts)
    assert.deepEqual(Object.keys(account).sort(), [
      "balance_usd",
      "label",
      "type",
    ]);
  assert.equal(snapshot.payload.synthetic, true);
  assert.equal(snapshot.payload.data_origin, "hardcoded_synthetic_demo");
  assert.equal(
    validAdvisorSnapshot(
      {
        ...snapshot,
        payload: { ...snapshot.payload, api_key: "synthetic-unexpected-field" },
      },
      "balance-transfer",
    ),
    false,
  );
  assert.equal(
    validAdvisorSnapshot(
      { ...snapshot, payload: { ...snapshot.payload, synthetic: false } },
      "balance-transfer",
    ),
    false,
  );
});
test("web requests require actual reads, preserve selected identity and never imply remembered data", () => {
  const snapshot = advisorSnapshot("refinance-term-tradeoff")!;
  const prompt = advisorWebRequest(
    "Analyze my finance info",
    snapshot,
    "https://customer.example",
  );
  assert.match(
    prompt,
    /Webpage context URL: https:\/\/customer.example\/advisor\/context\/v1\/refinance-term-tradeoff\?sha=/,
  );
  assert.ok(prompt.includes(snapshot.sha256));
  assert.ok(prompt.includes(snapshot.payload.comparison.goal));
  assert.match(
    prompt,
    /Do not claim a successful read without a successful tool result/,
  );
  for (const origin of [
    "http://external.example",
    "https://user:secret@customer.example",
    "https://customer.example/private",
  ])
    assert.throws(() => advisorWebRequest("question", snapshot, origin));
});
test("stored evidence preserves the known longer-term payment-versus-total-cost tradeoff", () => {
  const output = advisorContextPayload("refinance-term-tradeoff")!
    .calculator_evidence.outputs;
  assert.equal(
    (output.currentLoan as { monthlyPaymentUsd: string }).monthlyPaymentUsd,
    "$569.54",
  );
  assert.equal(
    (output.currentLoan as { totalOutOfPocketUsd: string }).totalOutOfPocketUsd,
    "$20,503.44",
  );
  assert.equal(
    (output.refiOffer as { monthlyPaymentUsd: string }).monthlyPaymentUsd,
    "$355.51",
  );
  assert.equal(
    (output.refiOffer as { totalOutOfPocketUsd: string }).totalOutOfPocketUsd,
    "$21,580.60",
  );
  assert.equal(output.monthlyPaymentDeltaUsd, "-$214.03");
  assert.equal(output.netTotalSavingsUsd, "-$1,077.16");
});

test("card evidence matches an independent Decimal monthly-cent payoff reference", () => {
  const output =
    advisorContextPayload("balance-transfer")!.calculator_evidence.outputs;
  const current = output.optionCurrent as {
    months: number;
    totalInterestUsd: string;
    totalCostUsd: string;
  };
  const transfer = output.optionTransfer as {
    months: number;
    upfrontFeeUsd: string;
    totalInterestUsd: string;
    totalCostUsd: string;
  };
  assert.equal(current.months, 14);
  assert.equal(current.totalInterestUsd, "$376.98");
  assert.equal(current.totalCostUsd, "$2,764.63");
  assert.equal(transfer.months, 13);
  assert.equal(transfer.upfrontFeeUsd, "$71.63");
  assert.equal(transfer.totalInterestUsd, "$0.00");
  assert.equal(transfer.totalCostUsd, "$2,459.28");
  assert.equal(output.netCostSavingsUsd, "$305.35");
});
