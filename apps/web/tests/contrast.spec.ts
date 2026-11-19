import { test, expect } from "@playwright/test";
const luminance = (rgb: string) => {
  const channels = rgb
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length !== 3)
    throw new Error(`Unexpected colour ${rgb}`);
  const values = channels
    .map((n) => n / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
};
test("discovery sign-in keeps AA text contrast while navigation changes its controls", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Paper investing", exact: true })
    .click();
  await expect(page.locator(".date-button")).toBeVisible();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Market discovery", exact: true })
    .click();
  const frames = await page
    .getByRole("button", { name: "Sign in for latest cycle", exact: true })
    .evaluate(async (node) => {
      const frames = [];
      for (let i = 0; i < 12; i++) {
        const style = getComputedStyle(node);
        frames.push({ color: style.color, background: style.backgroundColor });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
      return frames;
    });
  for (const frame of frames) {
    const a = luminance(frame.color),
      b = luminance(frame.background);
    expect(
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      JSON.stringify(frame),
    ).toBeGreaterThanOrEqual(4.5);
  }
});
