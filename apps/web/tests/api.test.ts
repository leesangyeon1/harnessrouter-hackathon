import test from "node:test";
import assert from "node:assert/strict";
import {
  FinanceApi,
  ApiError,
  fetchGuestToken,
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

test("sync retains preparing status, final zero counts and named unavailable products", async () => {
  const base = {
    accounts: 4,
    transactions: 0,
    liabilities: 0,
    holdings: 0,
    transactions_ready: false,
    unavailable: { holdings: "PRODUCTS_NOT_SUPPORTED" },
  };
  const api = new FinanceApi(
    "https://api.example.com",
    async () => "synthetic",
    async () => Response.json(base),
  );
  const status = await api.sync();
  assert.equal(status.transactions_ready, false);
  assert.equal(status.transactions, 0);
  assert.equal(status.unavailable.holdings, "PRODUCTS_NOT_SUPPORTED");
  const ready = new FinanceApi(
    "https://api.example.com",
    async () => "synthetic",
    async () =>
      Response.json({ ...base, transactions_ready: true, unavailable: {} }),
  );
  assert.equal((await ready.sync()).transactions_ready, true);
});

test("sync refuses unknown readiness and malformed availability rather than defaulting to ready", async () => {
  const base = {
    accounts: 4,
    transactions: 0,
    liabilities: 0,
    holdings: 0,
    transactions_ready: false,
    unavailable: {},
  };
  for (const overrides of [
    { transactions_ready: undefined },
    { transactions_ready: null },
    { transactions_ready: "false" },
    { unavailable: undefined },
    { unavailable: null },
    { unavailable: [] },
    { unavailable: { holdings: 0 } },
    { unavailable: { holdings: "" } },
    { unavailable: { accounts: "UNKNOWN" } },
  ]) {
    const api = new FinanceApi(
      "https://api.example.com",
      async () => "synthetic",
      async () => Response.json({ ...base, ...overrides }),
    );
    await assert.rejects(
      () => api.sync(),
      (error: unknown) => error instanceof ApiError && error.status === 502,
    );
  }
});

test("guest session token is minted once and cached for open customer access", async () => {
  let posts = 0;
  const transport: typeof fetch = async (url, init) => {
    posts++;
    assert.equal(String(url), "https://api.example.com/v1/auth/guest");
    assert.equal(init?.method, "POST");
    return Response.json({
      token: "guest-jwt-123",
      user_id: "guest_abc123",
      role: "user",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
  };
  const first = await fetchGuestToken("https://api.example.com", transport);
  const second = await fetchGuestToken("https://api.example.com", transport);
  assert.equal(first, "guest-jwt-123");
  assert.equal(second, "guest-jwt-123");
  assert.equal(posts, 1);
});
