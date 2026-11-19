import { test, expect } from "@playwright/test";

test("a generic advisor question carries the selected synthetic webpage identity", async ({
  page,
}) => {
  await page.route("**/v1/auth/guest", (route) =>
    route.fulfill({
      json: {
        token: "customer-fixture",
        user_id: "fixture-customer",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  );
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/v1/agent-tasks", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitted.push(route.request().postDataJSON());
    await route.fulfill({
      status: 503,
      json: {
        detail: "Synthetic transport stops after capturing the request.",
      },
    });
  });
  await page.goto("/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Finance advisor", exact: true })
    .click();
  await page
    .getByLabel("Financial comparison request and verified calculator inputs")
    .fill("Analyze my finance info and recommend a suggestion.");
  await page
    .getByRole("button", { name: "Analyze options", exact: true })
    .click();
  await expect.poll(() => submitted.length).toBe(1);
  expect(submitted[0].feature_key).toBe("advisor");
  expect(submitted[0].input).toContain("Webpage context URL:");
  expect(submitted[0].input).toContain("advisor-demo-v1");
  expect(submitted[0].input).toContain("balance-transfer");
  expect(submitted[0].input).toContain("Synthetic demonstration data");
});

test("public HTML and JSON share the exact selected scenario and reject stale hashes", async ({
  page,
}) => {
  const response = await page.request.get(
    "/advisor/context/v1/refinance-term-tradeoff/snapshot.json",
  );
  expect(response.status()).toBe(200);
  const snapshot = await response.json();
  expect(snapshot.payload.scenario_id).toBe("refinance-term-tradeoff");
  expect(snapshot.payload.calculator_evidence.outputs.netTotalSavingsUsd).toBe(
    "-$1,077.16",
  );
  const html = await (
    await page.request.get(
      `/advisor/context/v1/refinance-term-tradeoff?sha=${snapshot.sha256}`,
    )
  ).text();
  expect(html).toContain(snapshot.sha256);
  expect(html).toContain("Synthetic demonstration data");
  expect(html).toContain("-$1,077.16");
  expect(
    (
      await page.request.get(
        "/advisor/context/v1/refinance-term-tradeoff/snapshot.json?sha=stale",
      )
    ).status(),
  ).toBe(409);
  expect(
    (
      await page.request.get("/advisor/context/v1/unknown/snapshot.json")
    ).status(),
  ).toBe(404);
});

test("a missing webpage snapshot blocks analysis instead of silently sending an empty context", async ({
  page,
}) => {
  let submissions = 0;
  await page.route("**/advisor/context/v1/**/snapshot.json", (route) =>
    route.fulfill({ status: 503, json: { detail: "synthetic unavailable" } }),
  );
  await page.route("**/v1/agent-tasks", (route) => {
    if (route.request().method() === "POST") submissions++;
    return route.fulfill({ json: { tasks: [] } });
  });
  await page.goto("/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Finance advisor", exact: true })
    .click();
  await page
    .getByLabel("Financial comparison request and verified calculator inputs")
    .fill("Give a recommendation.");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "sample webpage is unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Analyze options", exact: true }),
  ).toBeDisabled();
  expect(submissions).toBe(0);
});
