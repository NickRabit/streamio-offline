import { expect, test } from "@playwright/test";

test("Safari landscape scrolls settings inside the app and restores its position", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  const main = page.locator(".app-shell > main");
  await expect(main).toHaveCSS("overflow-y", "auto");
  await expect.poll(() => main.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(350);
  // Wait for the section's asynchronous scroll restoration to finish.
  await page.waitForTimeout(1600);
  await main.evaluate((element) => element.scrollTo(0, 350));
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(350);
  await main.evaluate((element) => element.scrollBy(0, -100));
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(250);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(250);
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
});
