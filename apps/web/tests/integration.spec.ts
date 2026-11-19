import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const api = "http://127.0.0.1:4319";
const admin = "http://127.0.0.1:3101";

test("admin renews an expired server cookie from the current browser identity before an action", async ({
  page,
  context,
}) => {
  await page.request.post(`${api}/__test__/reset`, { data: {} });
  await mockIdentity(page, "admin");
  await page.goto(admin);
  await page.getByLabel("Email address").fill("admin@example.com");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page
    .getByRole("button", { name: "Open operations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Keep things moving." }),
  ).toBeVisible();
  // Let initial sign-in and page hydration settle before simulating idle expiry.
  // Next development streaming keeps the global network-idle state open.
  await page.waitForTimeout(1000);
  // Simulate the 50-minute cookie expiring without changing Firebase identity.
  await context.clearCookies({ name: "harness_admin_session" });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect
    .poll(async () =>
      (await context.cookies(admin)).some(
        (cookie) => cookie.name === "harness_admin_session",
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("heading", { name: "Keep things moving." }),
  ).toBeVisible();
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
async function loginCustomer(page: Page) {
  await mockIdentity(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Sign in and connect" }).click();
  await page.getByLabel("Email address").fill("customer@example.com");
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.locator(".workspace-badge")).toHaveText("Sandbox");
}

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
