import test from "node:test";
import assert from "node:assert/strict";
import { parseCycle } from "../src/lib/cycles";
import { ApiError, FinanceApi } from "../src/lib/api";

function fixture() {
  return {
    cycle_date: "2026-11-18",
    model_set_version: "daily-v1",
    policy_version: 1,
    sectors: {
      stock: {
        universe: "alpaca_us_equity",
        feed: "iex",
        coverage: { provider_listed: 23, selected: 2 },
        excluded: { EEE: "too_few_bars" },
        selections: [
          {
            symbol: "AAA",
            mean_dollar_volume: "900000000.0",
            mean_abs_move: "0.06005404864377939",
          },
          {
            symbol: "BBB",
            mean_dollar_volume: "100000000000000000001.125",
            mean_abs_move: "1.2E-7",
          },
        ],
      },
    },
  };
}
test("cycle figures retain exact strings, provider order, versions and scope", () => {
  const input = fixture();
  const result = parseCycle(input);
  assert.equal(result.sectors.crypto, undefined);
  assert.equal(result.sectors.stock?.coverage.eligible, undefined);
  assert.deepEqual(result, input);
  const empty = fixture();
  empty.sectors.stock.selections = [];
  assert.deepEqual(parseCycle(empty).sectors.stock?.selections, []);
});
test("malformed cycle identities and figures fail instead of becoming zeros", () => {
  for (const modify of [
    (data: ReturnType<typeof fixture>) => {
      data.cycle_date = "2026-02-30";
    },
    (data: ReturnType<typeof fixture>) => {
      data.policy_version = 0;
    },
    (data: ReturnType<typeof fixture>) => {
      data.sectors.stock.feed = "";
    },
    (data: ReturnType<typeof fixture>) => {
      data.sectors.stock.coverage.provider_listed = -1;
    },
    (data: ReturnType<typeof fixture>) => {
      data.sectors.stock.selections[0].mean_abs_move = "NaN";
    },
    (data: ReturnType<typeof fixture>) => {
      data.sectors.stock.selections[0].mean_abs_move = "1e999";
    },
    (data: ReturnType<typeof fixture>) => {
      data.sectors.stock.selections[0].mean_abs_move = "-0.1";
    },
    (data: ReturnType<typeof fixture>) => {
      data.sectors.stock.selections[1].symbol = "AAA";
    },
  ]) {
    const data = fixture();
    modify(data);
    assert.throws(() => parseCycle(data));
  }
  const numberInsteadOfString = fixture();
  assert.throws(() =>
    parseCycle({
      ...numberInsteadOfString,
      sectors: {
        stock: {
          ...numberInsteadOfString.sectors.stock,
          selections: [
            {
              symbol: "AAA",
              mean_dollar_volume: 900000000,
              mean_abs_move: "0.06",
            },
          ],
        },
      },
    }),
  );
});
test("latest-cycle transport authenticates and treats only 404 as no published cycle", async () => {
  let requested = "";
  let authorization = "";
  const api = new FinanceApi(
    "https://api.example.com",
    async () => "synthetic-current-id-token",
    async (url, init) => {
      requested = String(url);
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return Response.json(fixture());
    },
  );
  assert.deepEqual(await api.latestCycle(), fixture());
  assert.equal(requested, "https://api.example.com/v1/cycles/latest");
  assert.equal(authorization, "Bearer synthetic-current-id-token");
  for (const status of [404, 401, 403, 502]) {
    const failed = new FinanceApi(
      "https://api.example.com",
      async () => "synthetic",
      async () => new Response(null, { status }),
    );
    if (status === 404) assert.equal(await failed.latestCycle(), null);
    else
      await assert.rejects(
        () => failed.latestCycle(),
        (error: unknown) =>
          error instanceof ApiError && error.status === status,
      );
  }
});
