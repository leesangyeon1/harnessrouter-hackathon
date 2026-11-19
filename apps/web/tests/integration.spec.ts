import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const api = "http://127.0.0.1:4319";
const admin = "http://127.0.0.1:3101";

test("expired admin-ID session blocks operations and requires sign-in", async ({
  page,
  context,
}) => {
  await page.request.post(`${api}/__test__/reset`, { data: {} });
  await page.goto(admin);
  await page.getByLabel("Admin ID").fill("fixture-admin");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page
    .getByRole("button", { name: "Open operations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Keep things moving." }),
  ).toBeVisible();
  // The current ID/password flow has no Firebase browser identity to renew from.
  await context.clearCookies({ name: "harness_admin_session" });
  expect(
    (
      await page.request.post(`${admin}/api/worker-tokens`, {
        headers: { Origin: admin },
      })
    ).status(),
  ).toBe(401);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Admin ID")).toBeVisible();
  expect(
    (await context.cookies(admin)).some(
      (cookie) => cookie.name === "harness_admin_session",
    ),
  ).toBe(false);
});

async function mockIdentity(
  page: Page,
  role: "customer" | "admin" = "customer",
) {
  const identityId = `fixture-${role}`;
  const email = `${role}@example.com`;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: identityId, user_id: identityId, aud: "harness-test", iss: "https://securetoken.google.com/harness-test", iat: now, exp: now + 3600, auth_time: now, email, firebase: { sign_in_provider: "password", identities: { email: [email] } } })}.fixture-signature`;
  await page.route("https://securetoken.googleapis.com/**", async (route) => {
    const refreshedAt = Math.floor(
      (await page.evaluate(() => Date.now())) / 1000,
    );
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    const refreshed = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ ...payload, iat: refreshedAt, exp: refreshedAt + 3600 })}.fixture-signature`;
    await route.fulfill({
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        access_token: refreshed,
        id_token: refreshed,
        expires_in: "3600",
        refresh_token: "fixture-refresh",
        token_type: "Bearer",
        user_id: identityId,
        project_id: "harness-test",
      }),
    });
  });
  await page.route(
    "https://identitytoolkit.googleapis.com/**",
    async (route) => {
      const lookup = route.request().url().includes("accounts:lookup");
      await route.fulfill({
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(
          lookup
            ? {
                users: [
                  {
                    localId: identityId,
                    email,
                    emailVerified: true,
                    providerUserInfo: [
                      {
                        providerId: "password",
                        email,
                        federatedId: email,
                      },
                    ],
                  },
                ],
              }
            : {
                localId: identityId,
                email,
                idToken: token,
                refreshToken: "fixture-refresh",
                expiresIn: "3600",
              },
        ),
      });
    },
  );
}
async function loginCustomer(
  page: Page,
  entry: "connect" | "discovery" = "connect",
) {
  await mockIdentity(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open profile settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Sign in to your workspace", exact: true })
    .click();
  await page.getByLabel("Email address").fill("customer@example.com");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.locator(".workspace-badge")).toHaveText("Sandbox");
  if (entry === "discovery")
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "Market discovery", exact: true })
      .click();
}

test("published discovery preserves sector scope, coverage, precision and empty versus missing data", async ({
  page,
}) => {
  await page.request.post(`${api}/__test__/reset`, { data: {} });
  const plaidCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/plaid/")) plaidCalls.push(request.url());
  });
  await loginCustomer(page, "discovery");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Market discovery", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Cycle 2026-11-18", exact: true }),
  ).toBeVisible();
  const stock = page.getByRole("region", {
    name: "Stocks cycle screen",
    exact: true,
  });
  await expect(
    stock.getByText("alpaca_us_equity", { exact: true }),
  ).toBeVisible();
  await expect(stock.getByText("iex", { exact: true })).toBeVisible();
  await expect(stock.getByText("23", { exact: true })).toBeVisible();
  await expect(stock.getByText("900000000.0", { exact: true })).toBeVisible();
  await expect(
    stock.getByText("0.06005404864377939", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("daily-v1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Stable winner", exact: true }),
  ).toHaveCount(0);
  await stock.getByText("Named exclusions (1)", { exact: true }).click();
  await expect(stock.getByText("EEE", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "These qualified screens do not represent the whole market.",
      { exact: false },
    ),
  ).toBeVisible();
  if (await page.locator(".toast").isVisible())
    await page
      .getByRole("button", { name: "Dismiss notification", exact: true })
      .click();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: "evidence/cycle-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Crypto", exact: true }).click();
  await expect(page.getByText("alpaca_venue", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((node) => node.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: "evidence/cycle-mobile.png", fullPage: true });
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    a11y.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page.getByRole("button", { name: "Bond ETFs", exact: true }).click();
  await expect(
    page.getByText("No selections for this sector.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("bond_etf_list@1", { exact: true }),
  ).toBeVisible();
  await page.request.post(`${api}/__test__/cycle`, {
    data: { scenario: "partial" },
  });
  await page
    .getByRole("button", { name: "Refresh cycle", exact: true })
    .click();
  await page.getByRole("button", { name: "Crypto", exact: true }).click();
  await expect(
    page.getByText("Data not supplied", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(2);
  expect(plaidCalls).toEqual([]);
  await page.screenshot({ path: "evidence/cycle-partial.png", fullPage: true });
});

test("discovery handles 404, provider failure, loading and retry without a preview fallback", async ({
  page,
}) => {
  await page.request.post(`${api}/__test__/reset`, {
    data: { cycleScenario: "missing" },
  });
  await loginCustomer(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Market discovery", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No published cycle yet", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("AAPL", { exact: true })).toHaveCount(0);
  await page.request.post(`${api}/__test__/cycle`, {
    data: { scenario: "error" },
  });
  await page
    .getByRole("button", { name: "Refresh cycle", exact: true })
    .click();
  await expect(page.locator(".cycle-discovery .error-banner")).toContainText(
    "provider is temporarily unavailable",
  );
  await page.screenshot({ path: "evidence/cycle-error.png", fullPage: true });
  await page.request.post(`${api}/__test__/cycle`, {
    data: { scenario: "slow" },
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByText("Loading the latest published cycle…", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "evidence/cycle-loading.png", fullPage: true });
  await expect(
    page.getByRole("heading", { name: "Cycle 2026-11-18", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".cycle-discovery .error-banner")).toHaveCount(0);
  await page.request.post(`${api}/__test__/cycle`, {
    data: { scenario: "error" },
  });
  await page
    .getByRole("button", { name: "Refresh cycle", exact: true })
    .click();
  await expect(page.locator(".cycle-discovery .error-banner")).toContainText(
    "last retrieved screen remains",
  );
  await expect(page.getByText("AAA", { exact: true })).toBeVisible();
});

test("preparing transactions do not create an empty report; manual retries keep product errors explicit", async ({
  page,
}) => {
  await page.request.post(`${api}/__test__/reset`, {
    data: { scenario: "empty", syncScenario: "preparing" },
  });
  const syncCalls: string[] = [],
    writes: string[] = [],
    seeds: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().endsWith("/v1/plaid/sync")) syncCalls.push(request.url());
    if (request.url().endsWith("/v1/plaid/seed")) seeds.push(request.url());
    if (request.url().endsWith("/v1/reports/spending"))
      writes.push(request.url());
  });
  await loginCustomer(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Spending", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Connect Sandbox profile", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toEqual([]);
  await expect(page.locator(".sync-preparing")).toContainText(
    "Transactions are still arriving",
  );
  await expect(page.getByText("$0.00", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Export report", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".sync-unavailable")).toContainText(
    "Holdings not available from Plaid",
  );
  await expect(page.locator(".sync-unavailable")).toContainText(
    "PRODUCTS_NOT_SUPPORTED",
  );
  await expect(page.locator(".sync-unavailable")).toContainText(
    "Liabilities not available from Plaid",
  );
  await expect(page.locator(".sync-unavailable")).toContainText(
    "PRODUCT_NOT_READY",
  );
  if (await page.locator(".toast").isVisible())
    await page
      .getByRole("button", { name: "Dismiss notification", exact: true })
      .click();
  await page.screenshot({
    path: "evidence/plaid-preparing.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((node) => node.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "evidence/plaid-preparing-mobile.png",
    fullPage: true,
  });
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    a11y.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page.getByRole("button", { name: "Retry sync", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry sync", exact: true }),
  ).toBeEnabled();
  expect(syncCalls).toHaveLength(2);
  expect(seeds).toHaveLength(1);
  expect(writes).toEqual([]);
  await page.request.post(`${api}/__test__/sync`, {
    data: { scenario: "unavailable" },
  });
  await page.getByRole("button", { name: "Retry sync", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Where it went", exact: true }),
  ).toBeVisible();
  expect(syncCalls).toHaveLength(3);
  expect(seeds).toHaveLength(1);
  expect(writes).toHaveLength(1);
  await expect(page.getByText("$1,225.10", { exact: true })).toBeVisible();
  await expect(page.locator(".sync-preparing")).toHaveCount(0);
  await expect(page.locator(".sync-unavailable")).toContainText(
    "Previously saved information is unchanged",
  );
  if (await page.locator(".toast").isVisible())
    await page
      .getByRole("button", { name: "Dismiss notification", exact: true })
      .click();
  await page.screenshot({
    path: "evidence/plaid-unavailable.png",
    fullPage: true,
  });
});

test("token renewal preserves known preparing and unavailable states until sync says otherwise", async ({
  page,
}) => {
  await page.request.post(`${api}/__test__/reset`, {
    data: { scenario: "empty", syncScenario: "preparing" },
  });
  let tokenRefreshes = 0,
    reportWrites = 0;
  page.on("request", (request) => {
    if (request.url().includes("securetoken.googleapis.com")) tokenRefreshes++;
    if (
      request.url().endsWith("/v1/reports/spending") &&
      request.method() === "POST"
    )
      reportWrites++;
  });
  await loginCustomer(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Spending", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Connect Sandbox profile", exact: true })
    .click();
  await expect(page.locator(".sync-preparing")).toBeVisible();
  await page.clock.setFixedTime(new Date(Date.now() + 61 * 60 * 1000));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => tokenRefreshes).toBeGreaterThan(0);
  await expect(
    page.getByText("Updating your workspace…", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".sync-preparing")).toBeVisible();
  await expect(page.locator(".sync-unavailable")).toContainText(
    "PRODUCTS_NOT_SUPPORTED",
  );
  expect(reportWrites).toBe(0);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator(".workspace-badge")).toHaveText("Sample data");
  await expect(page.locator(".sync-notices")).toHaveCount(0);
});

test("a ready empty report is distinct from a preparing sync", async ({
  page,
}) => {
  await page.request.post(`${api}/__test__/reset`, {
    data: { scenario: "empty", syncScenario: "ready-empty" },
  });
  await loginCustomer(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Spending", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Connect Sandbox profile", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "No spending categories yet",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Plaid has finished preparing transactions.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.locator(".sync-preparing")).toHaveCount(0);
  await expect(page.locator(".sync-unavailable")).toHaveCount(0);
});

test("customer handles empty report, seed/sync/compute, partial data and sign out", async ({
  page,
}) => {
  await page.request.post(`${api}/__test__/reset`, {
    data: { scenario: "empty" },
  });
  await loginCustomer(page);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Spending", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A fresh start for your spending" }),
  ).toBeVisible();
  await page.screenshot({
    path: "evidence/customer-empty.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Connect Sandbox profile", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Where it went" }),
  ).toBeVisible();
  await expect(page.getByText("$1,225.10", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "evidence/customer-connected.png",
    fullPage: true,
  });
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your bigger picture starts here" }),
  ).toBeVisible();
  await expect(page.getByText("$42,850")).toHaveCount(0);
  await page.screenshot({
    path: "evidence/customer-partial.png",
    fullPage: true,
  });
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator(".workspace-badge")).toHaveText("Sample data");
  await expect(
    page.getByText("customer@example.com", { exact: true }),
  ).toHaveCount(0);
});
test("customer renders loading and recoverable provider errors", async ({
  page,
}) => {
  await page.request.post(`${api}/__test__/reset`, {
    data: { scenario: "slow" },
  });
  await loginCustomer(page);
  await expect(page.getByText("Updating your workspace…")).toBeVisible();
  await page.screenshot({
    path: "evidence/customer-loading.png",
    fullPage: true,
  });
  await expect(page.getByText("Updating your workspace…")).toHaveCount(0);
  await page.request.post(`${api}/__test__/scenario`, {
    data: { scenario: "error" },
  });
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Spending", exact: true })
    .click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".error-banner")).toContainText(
    "provider is temporarily unavailable",
  );
  await page.screenshot({
    path: "evidence/customer-error.png",
    fullPage: true,
  });
  await page.request.post(`${api}/__test__/scenario`, {
    data: { scenario: "report" },
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Where it went" }),
  ).toBeVisible();
});
test("admin server rejects anonymous, non-admin and cross-origin mutation requests", async ({
  page,
}) => {
  await page.request.post(`${api}/__test__/reset`, { data: {} });
  expect(
    (
      await page.request.get(`${admin}/workspace`, { maxRedirects: 0 })
    ).status(),
  ).toBe(307);
  expect((await page.request.get(`${admin}/api/worker-tokens`)).status()).toBe(
    401,
  );
  expect(
    (
      await page.request.delete(`${admin}/api/worker-tokens/invalid`, {
        headers: { Origin: admin },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await page.request.post(`${admin}/api/session`, {
        headers: { Origin: admin },
        data: { token: "customer-fixture" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post(`${admin}/api/session`, {
        headers: { Origin: "https://elsewhere.example" },
        data: { token: "admin-fixture" },
      })
    ).status(),
  ).toBe(403);
  await page.goto(admin);
  await page.screenshot({
    path: "evidence/admin-signin.png",
    fullPage: true,
    caret: "initial",
  });
});
test("admin issues a one-time credential, revokes it, and immediately loses access after role removal", async ({
  page,
}) => {
  await page.request.post(`${api}/__test__/reset`, { data: {} });
  const session = await page.request.post(`${admin}/api/session`, {
    headers: { Origin: admin },
    data: { token: "admin-fixture" },
  });
  expect(session.status()).toBe(200);
  expect(session.headers()["set-cookie"]).toContain("HttpOnly");
  await page.goto(`${admin}/workspace`);
  await expect(
    page.getByRole("heading", { name: "Keep things moving." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Issue worker credential", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Issue credential", exact: true })
    .click();
  await expect(page.locator(".secret-value code")).toHaveText(
    "synthetic-once-only-worker-token",
  );
  await page
    .getByRole("button", { name: "Dismiss and forget credential" })
    .click();
  await expect(
    page.getByText("synthetic-once-only-worker-token", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: "evidence/admin-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke credential", exact: true })
    .click();
  await expect(page.locator(".status")).toHaveText("Revoked");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: "evidence/admin-mobile.png", fullPage: true });
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    a11y.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page.request.post(`${api}/__test__/role`, { data: { role: "user" } });
  expect(
    (
      await page.request.get(`${admin}/workspace`, { maxRedirects: 0 })
    ).status(),
  ).toBe(403);
  expect((await page.request.get(`${admin}/api/worker-tokens`)).status()).toBe(
    403,
  );
  await page.goto(`${admin}/workspace`);
  await page.screenshot({ path: "evidence/admin-denied.png", fullPage: true });
});
