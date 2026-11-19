import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../src/lib/advisor-context";
import {
  parseAdvisorDbSnapshot,
  advisorDbSelection,
} from "../src/lib/advisor-db-context";
import { FinanceApi, ApiError } from "../src/lib/api";

const fixture = JSON.parse(
  readFileSync(
    new URL("./advisor-db-scenarios.fixture.json", import.meta.url),
    "utf8",
  ),
);
function snapshot(index = 0) {
  const payload = structuredClone(fixture.scenarios[index]);
  return {
    payload,
    sha256: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
    storage: {
      kind: "postgresql" as const,
      seed_version: fixture.seed_version,
      record_id: `test-record-${index}`,
    },
  };
}

test("stored scenario parser binds exact projected payload to DB provenance and hash", async () => {
  for (let index = 0; index < fixture.scenarios.length; index++) {
    const stored = snapshot(index);
    assert.deepEqual(
      await parseAdvisorDbSnapshot(stored, stored.payload.scenario_id),
      stored,
    );
    const selection = advisorDbSelection(stored);
    assert.deepEqual(Object.keys(selection).sort(), [
      "scenario_id",
      "scenario_version",
      "sha256",
    ]);
  }
  const edited = snapshot();
  edited.payload.scenario_version = "database-published-v2";
  edited.payload.comparison.label = "Label retrieved from the database";
  edited.sha256 = createHash("sha256")
    .update(canonicalJson(edited.payload))
    .digest("hex");
  assert.equal(
    (await parseAdvisorDbSnapshot(edited, "balance-transfer")).payload
      .comparison.label,
    edited.payload.comparison.label,
  );
});

test("unknown origin, tampered payload, mismatched scenario and extra private fields block analysis", async () => {
  const original = snapshot();
  await assert.rejects(
    parseAdvisorDbSnapshot(
      { ...original, sha256: "a".repeat(64) },
      "balance-transfer",
    ),
  );
  await assert.rejects(parseAdvisorDbSnapshot(original, "refinance-same-term"));
  for (const mutate of [
    (value: ReturnType<typeof snapshot>) => {
      value.payload.synthetic = false;
    },
    (value: ReturnType<typeof snapshot>) => {
      value.payload.data_origin = "frontend_constant";
    },
    (value: ReturnType<typeof snapshot>) => {
      value.payload.api_key = "test-private-field";
    },
    (value: ReturnType<typeof snapshot>) => {
      value.payload.comparison.normalized_inputs_and_option_terms.account_id =
        "test-provider-id";
    },
    (value: ReturnType<typeof snapshot>) => {
      value.payload.calculator_evidence.outputs.optionCurrent.account_mask =
        "test-mask";
    },
  ]) {
    const changed = snapshot();
    mutate(changed);
    changed.sha256 = createHash("sha256")
      .update(canonicalJson(changed.payload))
      .digest("hex");
    await assert.rejects(parseAdvisorDbSnapshot(changed, "balance-transfer"));
  }
});

test("API retrieves the stored record and submits only its selection, not client figures or page URLs", async () => {
  const stored = snapshot();
  const requests: { url: string; body?: unknown }[] = [];
  const api = new FinanceApi(
    "https://api.example.com",
    async () => "synthetic-session",
    async (url, init) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(
        init?.method === "POST" ? { id: "synthetic-task" } : stored,
      );
    },
  );
  const loaded = await api.advisorContext("balance-transfer");
  await api.startAgentTask("Compare this stored scenario.", {
    featureKey: "advisor",
    advisorContext: advisorDbSelection(loaded),
  });
  assert.match(
    requests[0].url,
    /advisor-context\?scenario_id=balance-transfer$/,
  );
  assert.deepEqual(requests[1].body, {
    input: "Compare this stored scenario.",
    feature_key: "advisor",
    advisor_context: advisorDbSelection(loaded),
  });
  const missing = new FinanceApi(
    "https://api.example.com",
    async () => "synthetic-session",
    async () => new Response(null, { status: 404 }),
  );
  await assert.rejects(
    missing.advisorContext("balance-transfer"),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 404 &&
      error.message.includes("database seed"),
  );
});
