import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("desktop overview and every customer destination remain usable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your money, in view." }),
  ).toBeVisible();
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "evidence/customer-desktop.png",
    fullPage: true,
  });
  for (const label of [
    "Spending",
    "Accounts",
    "Cards & loans",
    "Paper investing",
    "Market discovery",
    "Settings",
  ]) {
    await page
      .locator(".sidebar")
      .getByRole("button", { name: label, exact: true })
      .click();
    await expect(page.locator("main h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Spending", exact: true })
    .click();
  await page.getByLabel("Report month").selectOption("2026-10");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export report" }).click();
  expect((await download).suggestedFilename()).toBe(
    "harness-sample-spending-2026-10.csv",
  );
  await page.screenshot({
    path: "evidence/customer-spending.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("dialogs support keyboard close and search navigation", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Find something" }).click();
  await page
    .getByRole("textbox", { name: "Search your workspace" })
    .fill("paper");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Paper investing" })
    .click();
  await expect(
    page.getByRole("heading", { name: "A little room to explore." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Compare paper modes" }).click();
  await page.getByRole("button", { name: /Aggressive · 위험형/ }).click();
  await page.getByRole("button", { name: "Use this preview style" }).click();
  await expect(
    page.getByRole("heading", { name: "Open to more movement" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("mobile navigation and layout fit 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your money, in view." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "evidence/customer-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Spending", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Know where it goes." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
test("overview meets WCAG AA automated checks", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  await test.info().attach("accessibility", {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json",
  });
  expect(
    results.violations.map((v) => ({
      id: v.id,
      targets: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  ).toEqual([]);
});
test("secondary views preserve readable and keyboard-accessible content", async ({
  page,
}) => {
  await page.goto("/");
  const violations: unknown[] = [];
  for (const label of [
    "Spending",
    "Accounts",
    "Cards & loans",
    "Paper investing",
    "Market discovery",
    "Settings",
  ]) {
    await page
      .locator(".sidebar")
      .getByRole("button", { name: label, exact: true })
      .click();
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    violations.push(
      ...result.violations.map((v) => ({
        view: label,
        id: v.id,
        targets: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    );
  }
  expect(violations).toEqual([]);
});
test("keyboard focus, long labels and reduced motion remain usable on mobile", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    ),
  ).toBe("auto");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Accounts", exact: true })
    .click();
  await page
    .locator(".row-text strong")
    .first()
    .evaluate((node) => {
      node.textContent =
        "A very long institution and account display name for a narrow mobile viewport";
    });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "evidence/customer-long-label.png",
    fullPage: true,
  });
});
