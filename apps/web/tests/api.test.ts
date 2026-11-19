import test from "node:test";
import assert from "node:assert/strict";
import {
  FinanceApi,
  ApiError,
  parseReport,
  summarize,
  toCents,
  apiOrigin,
} from "../src/lib/api";

test("money stays exact until presentation, including refunds", () => {
  assert.equal(toCents("0.10") + toCents("0.20"), 30);
  assert.equal(toCents("-12.35"), -1235);
  for (const value of ["NaN", "Infinity", "1.999", "1e6", "900719925474099100"])
    assert.throws(() => toCents(value));
});
test("report parser validates backend decimal strings and categories", () => {
  const report = parseReport({
    id: "r1",
    kind: "spending",
    computed_at: "2026-11-18T10:00:00Z",
    figures: [
      { month: "2026-11", category: "FOOD_AND_DRINK", amount: "12.35" },
      { month: "2026-11", category: "FOOD_AND_DRINK", amount: "-2.35" },
    ],
  });
  assert.equal(summarize(report, "2026-11").total, 1000);
  assert.equal(summarize(report, "2026-10").total, 0);
  assert.throws(() =>
    parseReport({
      ...report,
      figures: [{ month: "2026-11", category: "FOOD", amount: 123 }],
    }),
  );
});
test("transport sends fresh bearer auth, refuses redirects and never sends cookies", async () => {
  let captured: RequestInit | undefined;
  const api = new FinanceApi(
    "https://api.example.com",
    async () => "test-id-token",
    async (_url, init) => {
      captured = init;
      return Response.json({ user_id: "u1", role: "user" });
    },
  );
  assert.deepEqual(await api.me(), { user_id: "u1", role: "user" });
  assert.equal(
    new Headers(captured?.headers).get("Authorization"),
    "Bearer test-id-token",
  );
  assert.equal(captured?.redirect, "error");
  assert.equal(captured?.credentials, "omit");
  assert.equal(captured?.cache, "no-store");
});
test("missing report is empty; auth and forbidden errors stay distinct", async () => {
  const api = new FinanceApi(
    "https://api.example.com",
    async () => "test",
    async () => new Response(null, { status: 404 }),
  );
  assert.equal(await api.spending(), null);
  for (const status of [401, 403, 429, 502]) {
    const failed = new FinanceApi(
      "https://api.example.com",
      async () => "test",
      async () =>
        Response.json({ detail: "untrusted provider details" }, { status }),
    );
    await assert.rejects(
      () => failed.me(),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === status &&
        !error.message.includes("untrusted"),
    );
  }
});
test("API origin accepts HTTPS or explicit local development only", () => {
  assert.equal(
    apiOrigin("https://api.example.com/"),
    "https://api.example.com",
  );
  assert.equal(apiOrigin("http://127.0.0.1:8000"), "http://127.0.0.1:8000");
  for (const url of [
    "http://example.com",
    "https://user:password@example.com",
    "javascript:alert(1)",
    "https://example.com?token=x",
  ])
    assert.throws(() => apiOrigin(url));
});
