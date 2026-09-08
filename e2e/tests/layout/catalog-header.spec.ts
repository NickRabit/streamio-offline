import { expect, test } from "@playwright/test";

test("description survives source loading and remains expandable", async ({ page }, testInfo) => {
  const description = "A long description that must remain readable without displacing the source controls. ".repeat(25);
  await page.route("**/api/meta/**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), description } });
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/stream-sources/**", async (route) => {
    const response = await route.fetch();
    await hold;
    await route.fulfill({ response });
  });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  const preview = page.locator(".description-preview");
  await expect(preview).toHaveText(description.trim());
  await expect(preview).toBeVisible();
  const before = await preview.boundingBox();
  release();
  await expect(page.locator(".stream-list button").first()).toBeVisible();
  await expect(preview).toBeVisible();
  const after = await preview.boundingBox();
  expect(Math.abs(after!.height - before!.height)).toBeLessThan(2);
  await page.locator(".catalog-description summary").click();
  await expect(page.locator(".catalog-description details")).toHaveAttribute("open", "");
  await expect(page.locator(".catalog-description details p")).toBeVisible();
  if (testInfo.project.name === "mobile") {
    const actions = await page.locator(".source-footer .actions").boundingBox();
    const navigation = await page.locator(".sidebar").boundingBox();
    for (const button of await page.locator(".source-footer .actions button").all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(navigation!.y);
  }
});

test("phone source scrolling hides metadata and restores it before reaching the top", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phone portrait has a collapsible metadata header");
  await page.route("**/api/streams/**", async (route) => {
    const response = await route.fetch();
    const streams = await response.json();
    await route.fulfill({ json: Array.from({ length: 40 }, (_, i) => ({ ...streams[0], name: `Source ${i}` })) });
  });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  const list = page.locator(".stream-list");
  await expect(list.locator("button")).toHaveCount(40);
  await list.evaluate((element) => { element.scrollTop = 500; });
  await expect(page.locator(".detail-panel .hero")).toBeHidden();
  await page.waitForTimeout(300);
  await list.evaluate((element) => { element.scrollTop -= 80; });
  await expect(page.locator(".detail-panel .hero")).toBeVisible();
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("phone catalog search returns when scrolling upwards", async ({ page }, testInfo) => {
  test.skip(!["mobile", "mobile-landscape"].includes(testInfo.project.name), "compact phone catalog");
  await page.route("**/api/catalog?**", async (route) => {
    const response = await route.fetch();
    const items = await response.json();
    await route.fulfill({ json: Array.from({ length: 60 }, (_, i) => ({ ...items[0], id: `catalog-${i}`, name: `Title ${i}` })) });
  });
  await page.goto("/");
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await expect(catalog).toBeVisible();
  const options = await catalog.locator("option").allTextContents();
  await catalog.selectOption({ label: options.find((text) => /Filmy/.test(text))! });
  const list = page.locator(".poster-grid");
  await expect(list.locator(".poster-card")).toHaveCount(60);
  await list.evaluate((element) => { element.scrollTop = 500; });
  await expect(page.locator(".searchbar")).toBeHidden();
  await page.waitForTimeout(300);
  await list.evaluate((element) => { element.scrollTop -= 80; });
  await expect(page.locator(".searchbar")).toBeVisible();
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
