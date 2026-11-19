import { test, expect } from "@playwright/test";
const admin = "http://127.0.0.1:3101";
const fixture = "http://127.0.0.1:4319";
test("admin sample runs once and fresh session reopens stored agent metrics", async ({
  browser,
  page,
}) => {
  await page.request.post(`${fixture}/__test__/reset`);
  for (const path of [
    "bundle",
    "tasks",
    "tasks/e5e4fe53-56f5-4390-9530-b32dc5e75dc3",
  ])
    expect(
      (await page.request.get(`${admin}/api/quant-emulator/${path}`)).status(),
    ).toBe(401);
  await page.request.post(`${admin}/api/session`, {
    headers: { Origin: admin },
    data: { token: "admin-fixture" },
  });
  expect(
    (
      await page.request.post(`${admin}/api/quant-emulator/tasks`, {
        headers: { Origin: "https://evil.example" },
        data: { input: "x", feature_key: "quant_eval" },
      })
    ).status(),
  ).toBe(403);
  await page.goto(`${admin}/workspace`);
  await page
    .getByRole("button", { name: "Quant emulator", exact: true })
    .click();
  await page.getByRole("button", { name: "Load sample bundle" }).click();
  await expect(
    page.getByText("synthetic_pinned_260d", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Run sample evaluation", exact: true })
    .click();
  await expect(
    page.getByText("Agent simulation_label: SIMULATED_FIXTURE", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "0.125", exact: true }),
  ).toBeVisible();
  const fresh = await browser.newContext();
  await fresh.request.post(`${admin}/api/session`, {
    headers: { Origin: admin },
    data: { token: "admin-fixture" },
  });
  const reopened = await fresh.newPage();
  await reopened.goto(`${admin}/workspace`);
  await reopened
    .getByRole("button", { name: "Quant emulator", exact: true })
    .click();
  await reopened.getByRole("button", { name: /completed.*2026-11-19/ }).click();
  await expect(
    reopened.getByText("Agent simulation_label: SIMULATED_FIXTURE", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    reopened.getByRole("cell", { name: "0.125", exact: true }),
  ).toBeVisible();
  expect(
    (
      await (
        await reopened.request.get(`${fixture}/__test__/quant-stats`)
      ).json()
    ).starts,
  ).toBe(1);
  await fresh.close();
  await page.request.post(`${fixture}/__test__/role`, {
    data: { role: "user" },
  });
  expect(
    (await page.request.get(`${admin}/api/quant-emulator/tasks`)).status(),
  ).toBe(403);
});
test("unparseable stored answer stays explicit without invented winners", async ({
  page,
}) => {
  await page.request.post(`${fixture}/__test__/reset`, {
    data: { scenario: "quant-unparsed" },
  });
  await page.request.post(`${admin}/api/session`, {
    headers: { Origin: admin },
    data: { token: "admin-fixture" },
  });
  await page.goto(`${admin}/workspace`);
  await page
    .getByRole("button", { name: "Quant emulator", exact: true })
    .click();
  await page.getByRole("button", { name: "Load sample bundle" }).click();
  await page
    .getByRole("button", { name: "Run sample evaluation", exact: true })
    .click();
  await expect(page.getByText(/stored answer did not parse/)).toBeVisible();
  await expect(page.getByText("Stable winner", { exact: true })).toHaveCount(0);
  await page.getByText("Exact stored answer", { exact: true }).click();
  await expect(
    page.getByText("Unparseable synthetic answer", { exact: true }),
  ).toBeVisible();
});
