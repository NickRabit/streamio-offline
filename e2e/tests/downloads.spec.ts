import { expect, test } from "@playwright/test";

test("queues a source and the job reaches the download list", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();

  const options = await page.getByRole("combobox", { name: "Procházet katalog" }).locator("option").allTextContents();
  await page.getByRole("combobox", { name: "Procházet katalog" }).selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  await page.getByRole("button", { name: /Zkušební film/ }).click();

  const detail = page.locator(".detail-panel");
  await expect(detail.getByRole("heading", { name: "Zdroje" })).toBeVisible();
  await detail.locator(".stream-list button").first().click();
  await detail.getByRole("button", { name: "Do knihovny" }).click();

  await expect(page.getByText("Přidáno do stahovací fronty.")).toBeVisible();

  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  const row = page.locator(".download-row", { hasText: "Zkušební film" });
  await expect(row).toBeVisible();
  // The sample file is a few kilobytes, so it is finished long before the poll
  // interval matters.
  await expect(row.locator(".job-status")).toHaveText("Dokončeno", { timeout: 20_000 });
});
