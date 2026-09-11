import { expect, test } from "@playwright/test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const sourceName = "Přesun zdroj";
const targetName = "Přesun cíl";
const downloads = path.resolve("e2e/.tmp/downloads");
const clip = "Přesouvaný klip.mkv";

test.beforeAll(async () => {
  await mkdir(path.join(downloads, sourceName), { recursive: true });
  await copyFile(sample, path.join(downloads, sourceName, clip));
  // Empty on purpose: browsing hides a folder with no video, the move dialog offers it.
  await mkdir(path.join(downloads, targetName), { recursive: true });
});

test.afterAll(async () => {
  for (const name of [sourceName, targetName]) await rm(path.join(downloads, name), { recursive: true, force: true });
});

test("a moved file takes the listing into its new folder and empties the old one", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.locator(".browse-item", { hasText: sourceName }).getByRole("button", { name: /Otevřít složku/ }).click();
  await expect(page.locator(".browse-item", { hasText: "Přesouvaný klip" })).toBeVisible();

  await page.getByRole("button", { name: /^Možnosti: Přesouvaný klip/ }).click();
  await page.getByRole("button", { name: "Přesunout", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // It opens in the folder the file sits in, which is no destination at all.
  await expect(dialog.getByRole("button", { name: "Přesunout sem" })).toBeDisabled();
  await dialog.locator(".move-crumbs button", { hasText: "Knihovna" }).click();
  await dialog.locator(".move-list button", { hasText: targetName }).click();
  await dialog.getByRole("button", { name: "Přesunout sem" }).click();

  await expect(dialog).toHaveCount(0);
  // The listing follows the file: the destination folder is open and the file is marked in it.
  await expect(page.locator(".crumbs button", { hasText: targetName })).toBeVisible();
  await expect(page.locator(".browse-item.focused", { hasText: "Přesouvaný klip" })).toBeVisible();

  await page.locator(".crumbs button", { hasText: "Knihovna" }).click();
  await expect(page.locator(".browse-item", { hasText: targetName })).toBeVisible();
  await expect(page.locator(".browse-item", { hasText: sourceName })).toHaveCount(0);
});
