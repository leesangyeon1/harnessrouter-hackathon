import type { AdvisorContextPayload } from "./advisor-context";
import { canonicalJson } from "./advisor-context";

export type AdvisorDbPayload = Omit<
  AdvisorContextPayload,
  "schema" | "data_origin" | "webpage_sample_overview"
> & {
  schema: "harness.advisor.db-context.v1";
  data_origin: "seeded_synthetic_db";
};
export type AdvisorDbSelection = {
  scenario_id: string;
  scenario_version: string;
  sha256: string;
};
export type AdvisorDbSnapshot = {
  payload: AdvisorDbPayload;
  sha256: string;
  storage: {
    kind: "postgresql";
    seed_version: string;
    record_id: string;
  };
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}

// Check the server's stored projection, never compare its figures with a frontend fixture.
export async function parseAdvisorDbSnapshot(
  value: unknown,
  expectedScenario: string,
): Promise<AdvisorDbSnapshot> {
  const invalid = () =>
    new Error(
      "The stored synthetic scenario could not be verified. Reload it before analyzing.",
    );
  if (!record(value) || !keys(value, ["payload", "sha256", "storage"]))
    throw invalid();
  const { payload, storage, sha256 } = value;
  if (
    !record(payload) ||
    !record(storage) ||
    !text(sha256) ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw invalid();
  if (
    !keys(storage, ["kind", "seed_version", "record_id"]) ||
    storage.kind !== "postgresql" ||
    !text(storage.seed_version) ||
    !text(storage.record_id)
  )
    throw invalid();
  if (
    !keys(payload, [
      "schema",
      "scenario_id",
      "scenario_version",
      "data_origin",
      "synthetic",
      "currency",
      "comparison",
      "calculator_evidence",
      "limitations",
    ]) ||
    payload.schema !== "harness.advisor.db-context.v1" ||
    payload.data_origin !== "seeded_synthetic_db" ||
    payload.synthetic !== true ||
    payload.currency !== "USD" ||
    payload.scenario_id !== expectedScenario ||
    !text(payload.scenario_version) ||
    !texts(payload.limitations)
  )
    throw invalid();
  const comparison = payload.comparison;
  const calculator = payload.calculator_evidence;
  if (
    !record(comparison) ||
    !keys(comparison, [
      "label",
      "kind",
      "goal",
      "normalized_inputs_and_option_terms",
    ]) ||
    !text(comparison.label) ||
    !text(comparison.goal) ||
    !["card", "refinance"].includes(String(comparison.kind)) ||
    !record(comparison.normalized_inputs_and_option_terms)
  )
    throw invalid();
  const inputKeys =
    comparison.kind === "card"
      ? [
          "balanceUsd",
          "currentAprPct",
          "monthlyPaymentUsd",
          "transferFeePct",
          "promoAprPct",
          "promoMonths",
          "postPromoAprPct",
        ]
      : [
          "principalUsd",
          "currentAprPct",
          "remainingMonths",
          "newAprPct",
          "newTermMonths",
          "refiFeeUsd",
        ];
  const inputs = comparison.normalized_inputs_and_option_terms;
  if (
    !keys(inputs, inputKeys) ||
    inputKeys.some(
      (key) => typeof inputs[key] !== "number" || !Number.isFinite(inputs[key]),
    )
  )
    throw invalid();
  if (
    !record(calculator) ||
    !keys(calculator, [
      "version",
      "status",
      "verification_scope",
      "source",
      "assumptions",
      "outputs",
    ]) ||
    !text(calculator.version) ||
    calculator.status !== "verified_by_app_calculator" ||
    !text(calculator.verification_scope) ||
    !text(calculator.source) ||
    !texts(calculator.assumptions) ||
    !record(calculator.outputs)
  )
    throw invalid();
  const outputKeys =
    comparison.kind === "card"
      ? ["optionCurrent", "optionTransfer", "netCostSavingsUsd"]
      : [
          "currentLoan",
          "refiOffer",
          "monthlyPaymentDeltaUsd",
          "netTotalSavingsUsd",
        ];
  const outputs = calculator.outputs;
  if (!keys(outputs, outputKeys) || outputKeys.some((key) => !(key in outputs)))
    throw invalid();
  const amountKeys =
    comparison.kind === "card"
      ? [
          "payable",
          "months",
          "upfrontFeeUsd",
          "totalInterestUsd",
          "totalCostUsd",
          "remainingAtPromoEndUsd",
        ]
      : [
          "monthlyPaymentUsd",
          "totalInterestUsd",
          "upfrontFeeUsd",
          "totalOutOfPocketUsd",
        ];
  for (const output of Object.values(calculator.outputs)) {
    if (record(output)) {
      if (
        !keys(output, amountKeys) ||
        Object.values(output).some(
          (item) =>
            item !== null &&
            typeof item !== "string" &&
            typeof item !== "boolean" &&
            !(typeof item === "number" && Number.isFinite(item)),
        )
      )
        throw invalid();
    } else if (output !== null && typeof output !== "string") throw invalid();
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(payload)),
  );
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== sha256) throw invalid();
  return value as AdvisorDbSnapshot;
}

export function advisorDbSelection(
  snapshot: AdvisorDbSnapshot,
): AdvisorDbSelection {
  return {
    scenario_id: snapshot.payload.scenario_id,
    scenario_version: snapshot.payload.scenario_version,
    sha256: snapshot.sha256,
  };
}
