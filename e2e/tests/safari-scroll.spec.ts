import { expect, test } from "@playwright/test";

test("Safari landscape keeps document scrolling available and restores its position", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  const main = page.locator(".app-shell > main");
  await expect(main).toHaveCSS("overflow-y", "visible");
  await expect(page.locator("body")).not.toHaveCSS("overflow-y", "hidden");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(350);
  // Wait for the section's asynchronous scroll restoration to finish.
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.scrollTo(0, 350));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(350);
  await page.evaluate(() => window.scrollBy(0, -100));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(250);
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(250);
  await page.getByRole("button", { name: "Nastavení", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("Safari landscape sidebar accepts touch navigation from every page", async ({ page }) => {
  await page.goto("/");
  for (const name of ["Nastavení", "Knihovna", "Stahování", "Doplňky", "Statistiky", "Katalog"]) {
    const button = page.locator(".sidebar").getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport();
    await button.tap();
    await expect(button).toHaveClass(/active/);
    await expect(page.locator(".app-shell > main")).toBeVisible();
    await expect(page.locator("body")).not.toHaveCSS("overflow-y", "hidden");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  }
});
