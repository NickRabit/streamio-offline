import { expect, test, type Page } from "@playwright/test";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const sample = path.resolve("e2e/fixtures/media/sample.mp4");
const folderName = "Zkušební film (2024)";
const folder = path.resolve("e2e/.tmp/downloads", folderName);

test.beforeAll(async () => {
  await mkdir(folder, { recursive: true });
  await copyFile(sample, path.join(folder, "Zkušební film.mkv"));
});

const fixtureTile = (page: Page) => page.locator(".browse-item", { hasText: folderName });

test("scan library matches the unique fixture folder", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(fixtureTile(page)).toBeVisible();
  await page.getByRole("button", { name: "Prohledat knihovnu" }).click();
  await expect(page.getByText(/spárováno,/)).toBeVisible({ timeout: 20_000 });
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
});

test("identify binds a library folder to the catalog title", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await expect(fixtureTile(page)).toBeVisible();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  const identify = page.getByRole("button", { name: "Přiřadit…" });
  const fix = page.getByRole("button", { name: "Opravit přiřazení…" });
  if (await identify.isVisible()) await identify.click();
  else await fix.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Zkušební film/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Použít tento titul" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
  await expect(fixtureTile(page)).toContainText("2024");
});

test("unmatch clears the description and Identify stays available", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
  await expect(page.getByText("Nepřiřazeno.")).toBeVisible();
  await expect(fixtureTile(page).locator(".library-desc")).toHaveCount(0);
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  await expect(page.getByRole("button", { name: "Přiřadit…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nehledat v katalogu" })).toBeVisible();
});

test("unmatch lets a later scan match again", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  if (await page.getByRole("button", { name: "Zrušit přiřazení" }).isVisible()) {
    await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
  } else {
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button", { name: "Prohledat knihovnu" }).click();
  await expect(page.getByText(/spárováno,/)).toBeVisible({ timeout: 20_000 });
  await expect(fixtureTile(page).locator(".library-desc")).toContainText("Film, který existuje jen pro testy.");
});

test("skip catalog lookup keeps the title unmatched through a scan", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Knihovna", exact: true }).click();
  await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  if (await page.getByRole("button", { name: "Zrušit přiřazení" }).isVisible()) {
    await page.getByRole("button", { name: "Zrušit přiřazení" }).click();
    await page.getByRole("button", { name: `Možnosti: ${folderName}` }).click();
  }
  await page.getByRole("button", { name: "Nehledat v katalogu" }).click();
  await expect(page.getByText("Vyhledání v katalogu je vypnuté.")).toBeVisible();
  await page.getByRole("button", { name: "Prohledat knihovnu" }).click();
  await expect(page.getByText(/spárováno,/)).toBeVisible({ timeout: 20_000 });
  await expect(fixtureTile(page).locator(".library-desc")).toHaveCount(0);
});
