// Local-only transport fixture. Never imported by either application.
import http from "node:http";
let role = "admin";
let scenario = "report";
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
      tokens = [];
      seeded = false;
    }
    if (path.endsWith("role")) role = data.role;
    if (path.endsWith("scenario")) scenario = data.scenario;
    send({ status: "ok" });
    return;
  }
  const token = req.headers.authorization?.replace("Bearer ", "");
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
  if (path.startsWith("/v1/admin/")) {
    if (!adminToken || role !== "admin") {
      send({ detail: "admin required" }, 403);
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
    send({ accounts: 4, transactions: 12, liabilities: 2, holdings: 1 });
    return;
  }
  if (path === "/v1/reports/spending") {
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
