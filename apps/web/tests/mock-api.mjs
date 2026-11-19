// Local-only transport fixture. Never imported by either application.
import http from "node:http";
let role = "admin";
let scenario = "report";
let cycleScenario = "ready";
let syncScenario = "ready";
let quantStarts = 0;
let quantTasks = [];
const quantPins = {
  cycle_id: "sample-AAPL",
  symbol: "AAPL",
  sector: "stock",
  data_origin: "synthetic_pinned_260d",
  model_set_version: "daily-v1",
  policy_version: 1,
  bars_count: 260,
  bars_hash: "a".repeat(64),
  policy_hash: "b".repeat(64),
  costs_hash: "c".repeat(64),
  confirmation_bars: 60,
  cost_per_side: 0.001,
};
// Synthetic local screen; no live market/provider data is used here.
const stockCoverage = {
  provider_listed: 23,
  not_active: 2,
  not_tradable: 1,
  not_fractionable: 2,
  not_on_list: 5,
  not_usd: 0,
  too_few_bars: 1,
  missing_screen_date: 0,
  eligible: 13,
  liquidity_ranked: 5,
  selected: 3,
};
const cycle = {
  cycle_date: "2026-11-18",
  model_set_version: "daily-v1",
  policy_version: 1,
  sectors: {
    stock: {
      universe: "alpaca_us_equity",
      feed: "iex",
      coverage: stockCoverage,
      excluded: { EEE: "too_few_bars" },
      selections: [
        {
          symbol: "AAA",
          mean_dollar_volume: "900000000.0",
          mean_abs_move: "0.06005404864377939",
        },
        {
          symbol: "BBB",
          mean_dollar_volume: "800000000.0",
          mean_abs_move: "0.05",
        },
        {
          symbol: "CCC",
          mean_dollar_volume: "700000000.0",
          mean_abs_move: "0.04",
        },
      ],
    },
    bond: {
      universe: "bond_etf_list@1",
      feed: "iex",
      coverage: {
        ...stockCoverage,
        provider_listed: 7,
        not_active: 1,
        not_tradable: 0,
        not_fractionable: 1,
        not_on_list: 0,
        eligible: 5,
        liquidity_ranked: 2,
        too_few_bars: 2,
        selected: 0,
      },
      excluded: {
        BND: "not_fractionable",
        TIP: "not_active",
        TLT: "too_few_bars",
        IEF: "too_few_bars",
      },
      selections: [],
    },
    crypto: {
      universe: "alpaca_crypto_usd",
      feed: "alpaca_venue",
      coverage: {
        ...stockCoverage,
        provider_listed: 4,
        not_active: 0,
        not_tradable: 1,
        not_fractionable: 0,
        not_on_list: 0,
        not_usd: 1,
        too_few_bars: 0,
        eligible: 2,
        liquidity_ranked: 1,
        selected: 1,
      },
      excluded: {},
      selections: [
        {
          symbol: "BTC/USD",
          mean_dollar_volume: "1500000.125",
          mean_abs_move: "0.0125",
        },
      ],
    },
  },
};
let seeded = false;
let tokens = [];
const report = {
  id: "fixture-report",
  kind: "spending",
  computed_at: "2026-11-18T12:00:00Z",
  figures: [
    { month: "2026-11", category: "FOOD_AND_DRINK", amount: "25.10" },
    { month: "2026-11", category: "RENT_AND_UTILITIES", amount: "1200.00" },
  ],
};
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (["http://127.0.0.1:3100", "http://127.0.0.1:3101"].includes(origin))
    res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const path = new URL(req.url, "http://127.0.0.1:4319").pathname;
  const send = (data, status = 200) => {
    res.writeHead(status);
    res.end(status === 204 ? undefined : JSON.stringify(data));
  };
  if (path.startsWith("/__test__/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    if (path.endsWith("reset")) {
      role = "admin";
      scenario = data.scenario ?? "report";
      cycleScenario = data.cycleScenario ?? "ready";
      syncScenario = data.syncScenario ?? "ready";
      tokens = [];
      seeded = false;
      quantStarts = 0;
      quantTasks = [];
    }
    if (path.endsWith("quant-stats")) {
      send({ starts: quantStarts });
      return;
    }
    if (path.endsWith("role")) role = data.role;
    if (path.endsWith("scenario")) scenario = data.scenario;
    if (path.endsWith("cycle")) cycleScenario = data.scenario;
    if (path.endsWith("sync")) syncScenario = data.scenario;
    send({ status: "ok" });
    return;
  }
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (path === "/v1/auth/admin-login" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const credentials = JSON.parse(raw);
    const valid =
      credentials.username === "fixture-admin" &&
      credentials.password === "fixture-password";
    send(
      valid
        ? { token: "admin-fixture" }
        : { detail: "Invalid fixture credentials" },
      valid ? 200 : 401,
    );
    return;
  }
  let adminToken = token === "admin-fixture";
  // Synthetic JWT identity only; this local fixture does not verify signatures.
  try {
    adminToken ||=
      JSON.parse(
        Buffer.from(token?.split(".")[1] ?? "", "base64url").toString(),
      ).sub === "fixture-admin";
  } catch {}
  if (!token) {
    send({ detail: "sign-in required" }, 401);
    return;
  }
  if (path === "/v1/me") {
    send({
      user_id: adminToken ? "fixture-admin" : "fixture-customer",
      role: adminToken ? role : "user",
    });
    return;
  }
  if (path === "/v1/agent-tasks/quant-bundle") {
    send({
      prompt: "synthetic pinned quant input",
      pinned_identities: quantPins,
      available_cycle_symbols: [],
    });
    return;
  }
  if (path === "/v1/agent-tasks" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    if (
      input.feature_key !== "quant_eval" ||
      input.input !== "synthetic pinned quant input"
    ) {
      send({ detail: "invalid fixture input" }, 400);
      return;
    }
    quantStarts++;
    const result = {
      status: "ok",
      simulation_label: "SIMULATED_FIXTURE",
      evaluations: [
        {
          cycle_id: "sample-AAPL",
          symbol: "AAPL",
          pinned_identities: quantPins,
          stable_winner: "M02",
          aggressive_winner: null,
          candidate_metrics: [
            {
              model_id: "M02",
              selection: { net_return: 0.125, sharpe: 1.2, max_drawdown: 0.1 },
              confirmation: {
                net_return: 0.02,
                sharpe: 0.8,
                max_drawdown: 0.03,
              },
            },
          ],
        },
      ],
      issues: [],
    };
    const task = {
      id: "e5e4fe53-56f5-4390-9530-b32dc5e75dc3",
      feature_key: "quant_eval",
      status: "completed",
      query: "Synthetic sample evaluation",
      answer:
        scenario === "quant-unparsed"
          ? "Unparseable synthetic answer"
          : JSON.stringify(result),
      quant_result: scenario === "quant-unparsed" ? null : result,
      created_at: "2026-11-19T14:00:00Z",
      updated_at: "2026-11-19T14:00:01Z",
    };
    quantTasks = [task];
    send(task, 201);
    return;
  }
  if (path === "/v1/agent-tasks") {
    send({ tasks: quantTasks });
    return;
  }
  if (path.startsWith("/v1/agent-tasks/")) {
    const task = quantTasks.find((item) => path.endsWith(item.id));
    send(task ?? { detail: "not found" }, task ? 200 : 404);
    return;
  }
  if (path.startsWith("/v1/admin/")) {
    if (!adminToken || role !== "admin") {
      send({ detail: "admin required" }, 403);
      return;
    }
    if (path === "/v1/admin/quant-performance" && req.method === "GET") {
      send({
        cycles: [],
        selected_cycle: null,
        worker_nodes: tokens.map((t) => ({
          worker_id: t.id,
          created_at: t.created_at,
          revoked_at: t.revoked_at,
          active_leases: 0,
          completed_units_in_cycle: 0,
          completed_units_total: 0,
          last_completed_at: null,
        })),
        event_log: [],
      });
      return;
    }
    if (req.method === "GET") {
      send({ tokens });
      return;
    }
    if (req.method === "POST") {
      const id = "1a7f03c7-bb8e-45f6-856f-d5307a6f57d4";
      tokens.push({ id, created_at: "2026-11-18T12:00:00Z", revoked_at: null });
      send({ id, token: "synthetic-once-only-worker-token" }, 201);
      return;
    }
    if (req.method === "DELETE") {
      tokens = tokens.map((t) => ({
        ...t,
        revoked_at: "2026-11-18T13:00:00Z",
      }));
      send(null, 204);
      return;
    }
  }
  if (path === "/v1/plaid/seed") {
    if (seeded) send({ detail: "already exists" }, 409);
    else {
      seeded = true;
      send({ status: "seeded" }, 201);
    }
    return;
  }
  if (path === "/v1/plaid/sync") {
    const unavailable = ["preparing", "unavailable"].includes(syncScenario)
      ? { liabilities: "PRODUCT_NOT_READY", holdings: "PRODUCTS_NOT_SUPPORTED" }
      : {};
    send({
      accounts: 4,
      transactions: ["preparing", "ready-empty"].includes(syncScenario)
        ? 0
        : 12,
      liabilities: Object.keys(unavailable).length ? 0 : 2,
      holdings: Object.keys(unavailable).length ? 0 : 1,
      transactions_ready: syncScenario !== "preparing",
      unavailable,
    });
    return;
  }
  if (path === "/v1/cycles/latest") {
    if (cycleScenario === "slow")
      await new Promise((resolve) => setTimeout(resolve, 1500));
    if (cycleScenario === "missing") {
      send({ detail: "no cycle" }, 404);
      return;
    }
    if (cycleScenario === "error") {
      send({ detail: "synthetic provider failure" }, 502);
      return;
    }
    if (cycleScenario === "partial") {
      send({
        ...cycle,
        sectors: { stock: cycle.sectors.stock, bond: cycle.sectors.bond },
      });
      return;
    }
    send(cycle);
    return;
  }
  if (path === "/v1/reports/spending") {
    if (
      req.method === "POST" &&
      ["preparing", "ready-empty"].includes(syncScenario)
    ) {
      send({ ...report, figures: [] }, 201);
      return;
    }
    if (scenario === "slow")
      await new Promise((resolve) => setTimeout(resolve, 1500));
    if (scenario === "error") {
      send({ detail: "synthetic provider failure" }, 502);
      return;
    }
    if (scenario === "empty" && req.method === "GET") {
      send({ detail: "no report" }, 404);
      return;
    }
    scenario = "report";
    send(report, req.method === "POST" ? 201 : 200);
    return;
  }
  send({ detail: "not found" }, 404);
});
server.listen(4319, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
