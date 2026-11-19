import test from "node:test";
import assert from "node:assert/strict";
import {
  AdminGateError,
  checkAdmin,
  checkOrigin,
  safeOrigin,
  validTokenId,
} from "../src/lib/security";
test("server gate denies unauthenticated and non-admin sessions", async () => {
  await assert.rejects(
    () => checkAdmin(undefined, "https://api.example.com"),
    (e) => e instanceof AdminGateError && e.status === 401,
  );
  await assert.rejects(
    () =>
      checkAdmin("token", "https://api.example.com", async () =>
        Response.json({ user_id: "u1", role: "user" }),
      ),
    (e) => e instanceof AdminGateError && e.status === 403,
  );
});
test("current backend role is checked every time and redirects are refused", async () => {
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return Response.json({
      user_id: "a1",
      role: calls === 1 ? "admin" : "user",
    });
  };
  assert.equal(
    (await checkAdmin("token", "https://api.example.com", transport)).role,
    "admin",
  );
  await assert.rejects(
    () => checkAdmin("token", "https://api.example.com", transport),
    (e) => e instanceof AdminGateError && e.status === 403,
  );
  assert.equal(calls, 2);
});
test("backend failures fail closed", async () => {
  for (const status of [401, 403, 500])
    await assert.rejects(
      () =>
        checkAdmin(
          "token",
          "https://api.example.com",
          async () => new Response(null, { status }),
        ),
      AdminGateError,
    );
  await assert.rejects(
    () =>
      checkAdmin("token", "https://api.example.com", async () => {
        throw new Error("network");
      }),
    AdminGateError,
  );
});
test("mutation origin and credential ids cannot choose another destination", () => {
  checkOrigin("https://ops.example.com", "https://ops.example.com");
  for (const origin of [null, "https://evil.example", "null"])
    assert.throws(
      () => checkOrigin(origin, "https://ops.example.com"),
      AdminGateError,
    );
  assert.throws(() => safeOrigin("http://api.example.com"));
  assert.throws(() => safeOrigin("https://user:password@api.example.com"));
  assert.equal(validTokenId("243cc4f2-4dc1-458d-bf5e-dad384ab5083"), true);
  assert.equal(validTokenId("../../another-api"), false);
});
