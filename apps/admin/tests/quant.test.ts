import test from "node:test";
import assert from "node:assert/strict";
import { proxyQuant } from "../src/lib/quant-proxy";
import { AdminGateError, checkAdmin } from "../src/lib/security";
import { candidates, evaluations, reported } from "../src/lib/quant-result";

const base = "https://api.example.com",
  origin = "https://ops.example.com";
const id = "e5e4fe53-56f5-4390-9530-b32dc5e75dc3";
const request = (
  path = "/tasks",
  method = "GET",
  payload?: unknown,
  source = origin,
) =>
  new Request(`${origin}${path}`, {
    method,
    headers: { Origin: source },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
test("all four quant operations recheck admin role and never follow redirects", async () => {
  for (const role of ["user", "admin"]) {
    let gates = 0,
      calls = 0;
    const dependencies = {
      base,
      origin,
      session: async () => {
        gates++;
        await checkAdmin("synthetic", base, async () =>
          Response.json({ role, user_id: "fixture" }),
        );
        return { token: "synthetic" };
      },
      transport: async (url: string | URL | Request, init?: RequestInit) => {
        calls++;
        assert.equal(init?.redirect, "error");
        assert.equal(init?.cache, "no-store");
        assert.equal(init?.credentials, "omit");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer synthetic",
        );
        assert.ok(String(url).startsWith(base + "/v1/agent-tasks"));
        return Response.json({ feature_key: "quant_eval" });
      },
    };
    for (const [req, target, taskId] of [
      [request("/bundle?mode=sample"), "bundle", undefined],
      [request(), "tasks", undefined],
      [
        request("/tasks", "POST", {
          input: "synthetic pinned input",
          feature_key: "quant_eval",
        }),
        "tasks",
        undefined,
      ],
      [request(), "detail", id],
    ] as const) {
      if (role === "admin") await proxyQuant(req, target, dependencies, taskId);
      else
        await assert.rejects(
          () => proxyQuant(req, target, dependencies, taskId),
          (e) => e instanceof AdminGateError && e.status === 403,
        );
    }
    assert.equal(gates, 4);
    assert.equal(calls, role === "admin" ? 4 : 0);
  }
});
test("fixed routes reject foreign origins, alternate features, followups and path injection before forwarding", async () => {
  let calls = 0;
  const dependencies = {
    base,
    origin,
    session: async () => ({ token: "synthetic" }),
    transport: async () => {
      calls++;
      return Response.json({});
    },
  };
  for (const payload of [
    { input: "x", feature_key: "advisor" },
    { input: "x", feature_key: "quant_eval", follow_up_task_id: id },
  ])
    await assert.rejects(
      () =>
        proxyQuant(request("/tasks", "POST", payload), "tasks", dependencies),
      AdminGateError,
    );
  await assert.rejects(
    () =>
      proxyQuant(
        request(
          "/tasks",
          "POST",
          { input: "x", feature_key: "quant_eval" },
          "https://elsewhere.example",
        ),
        "tasks",
        dependencies,
      ),
    AdminGateError,
  );
  await assert.rejects(
    () => proxyQuant(request(), "detail", dependencies, "../../jobs"),
    AdminGateError,
  );
  await assert.rejects(
    () =>
      proxyQuant(
        request("/bundle?symbol=https://evil.example"),
        "bundle",
        dependencies,
      ),
    AdminGateError,
  );
  assert.equal(calls, 0);
});
test("POST is forwarded once and upstream errors are preserved without replay", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      proxyQuant(
        request("/tasks", "POST", {
          input: "exact bundle",
          feature_key: "quant_eval",
        }),
        "tasks",
        {
          base,
          origin,
          session: async () => ({ token: "synthetic" }),
          transport: async (_url, init) => {
            calls++;
            assert.equal(
              init?.body,
              JSON.stringify({
                input: "exact bundle",
                feature_key: "quant_eval",
              }),
            );
            return Response.json(
              { detail: "HarnessRouter unavailable" },
              { status: 503 },
            );
          },
        },
      ),
    /HarnessRouter unavailable/,
  );
  assert.equal(calls, 1);
});
test("metrics preserve source order, missing values, null winners and parse failure", () => {
  assert.equal(evaluations(null), null);
  assert.equal(evaluations({ status: "ok", evaluations: [null] }), null);
  assert.deepEqual(evaluations({ status: "ok", evaluations: [] }), []);
  assert.equal(reported(undefined), "Unknown");
  assert.equal(reported(null), "None (reported null)");
  const items = candidates([
    { model_id: "M02", selection: { net_return: 0, sharpe: -1 } },
    { model_id: "M01", confirmation_net_return: "0.12345678901234567890" },
  ]);
  assert.deepEqual(
    items.map((item) => item.id),
    ["M02", "M01"],
  );
  assert.equal(items[0].values[0], 0);
  assert.equal(items[0].values[2], undefined);
  assert.equal(items[1].values[3], "0.12345678901234567890");
});
