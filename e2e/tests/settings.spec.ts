import { expect, test } from "@playwright/test";

test.describe("settings", () => {
  test("a changed setting survives a reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();

    const tileSize = page.getByRole("combobox", { name: "Velikost položek katalogu" });
    await tileSize.selectOption("large");
    await expect(page.getByText("Nastavení uloženo.")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Velikost položek katalogu" })).toHaveValue("large");

    await page.getByRole("combobox", { name: "Velikost položek katalogu" }).selectOption("medium");
  });

  test("diagnostics reports the running server", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Nastavení", exact: true }).click();
    await page.locator("button.diagnostics-toggle").click();

    const facts = page.locator(".diagnostics-facts");
    await expect(facts).toContainText("Server běží");
    await expect(facts).toContainText("Volné místo");
  });
});
