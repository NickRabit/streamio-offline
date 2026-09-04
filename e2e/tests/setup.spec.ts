import { expect, test } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

// Runs before every other spec and leaves behind the session the rest reuse.
// It is a real journey, not scaffolding: a fresh server shows the account form
// and has no addons until one is added by hand.
test("first run: create the account and install an addon", async ({ page }) => {
  await page.goto("/");

  const form = page.locator("form.login-card");
  await expect(form).toContainText("Server zatím nemá žádný účet");

  await form.getByLabel("Uživatelské jméno").fill("e2e-admin");
  await form.getByLabel("Heslo", { exact: true }).fill("e2e-password");
  await form.getByLabel("Heslo znovu").fill("e2e-password");
  await form.getByRole("button", { name: "Založit účet" }).click();

  await expect(page.getByRole("heading", { name: "Co chcete sledovat?" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Přidejte první Stremio doplněk" })).toBeVisible();

  await page.getByRole("button", { name: "Doplňky", exact: true }).click();
  await page.getByLabel("URL manifestu").fill(addonManifest);
  await page.getByRole("button", { name: "Přidat" }).click();

  await expect(page.getByText("Manifest byl přidán.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E doplněk" })).toBeVisible();

  await page.context().storageState({ path: "e2e/.tmp/session.json" });
});
