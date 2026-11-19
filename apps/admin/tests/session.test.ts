import test from "node:test";
import assert from "node:assert/strict";
import { sessionRequest } from "../src/lib/session";

test("renewal obtains the current token before each operation and never replays a mutation", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  let acquisitions = 0;
  const transport: typeof fetch = async (path, init) => {
    calls.push({ path: String(path), init });
    return Response.json({ ok: true });
  };
  for (let i = 0; i < 2; i++)
    await sessionRequest(
      "/api/worker-tokens",
      { method: "POST" },
      async () => `fresh-${++acquisitions}`,
      transport,
    );
  assert.equal(acquisitions, 2);
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/session",
      "/api/worker-tokens",
      "/api/session",
      "/api/worker-tokens",
    ],
  );
  assert.equal(calls[0].init?.body, JSON.stringify({ token: "fresh-1" }));
  assert.equal(calls[2].init?.body, JSON.stringify({ token: "fresh-2" }));
  for (const { init } of calls) {
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "same-origin");
  }
});

test("failed renewal blocks the operation; a transport failure is not retried", async () => {
  for (const status of [401, 403, 503]) {
    const calls: string[] = [];
    const response = await sessionRequest(
      "/api/worker-tokens",
      { method: "POST" },
      async () => "synthetic-token",
      async (path) => {
        calls.push(String(path));
        return new Response(null, { status });
      },
    );
    assert.equal(response.status, status);
    assert.deepEqual(calls, ["/api/session"]);
  }
  let attempts = 0;
  await assert.rejects(
    () =>
      sessionRequest(
        "/api/worker-tokens",
        { method: "POST" },
        async () => "synthetic-token",
        async () => {
          attempts++;
          throw new Error("offline");
        },
      ),
    /offline/,
  );
  assert.equal(attempts, 1);
});
