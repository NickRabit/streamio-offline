import { expect, test } from "@playwright/test";
import { addonManifest } from "../../../playwright.config";

test.afterEach(async ({ request }) => {
  await request.get(new URL("/proxy-control?mode=video", addonManifest).href);
});

test("player keeps its picture stable and its overlay controls reachable", async ({ page, request }) => {
  await request.get(new URL("/proxy-control?mode=browser", addonManifest).href);
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  const option = await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value");
  await catalog.selectOption(option!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();
  const overlay = page.locator(".player-overlay");
  const video = overlay.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => {
    element.loop = true;
    const track = element.addTextTrack("subtitles", "Layout", "cs");
    track.addCue(new VTTCue(0, 3600, "First subtitle line\nSecond subtitle line"));
    track.mode = "showing";
  });
  await overlay.dispatchEvent("pointermove");
  const before = await video.boundingBox();
  const close = await overlay.getByRole("button", { name: "Zavřít přehrávač", exact: true }).boundingBox();
  expect(close!.y).toBeLessThan(50);
  const cues = overlay.locator(".player-subtitles");
  await expect(cues).toBeVisible();
  const bottom = await overlay.locator(".player-bottom").boundingBox();
  const raised = await cues.boundingBox();
  expect(raised!.y + raised!.height).toBeLessThan(bottom!.y + 1);
  await expect(overlay).toHaveClass(/controls-hidden/, { timeout: 8000 });
  expect(await video.boundingBox()).toEqual(before);
  await expect.poll(async () => (await cues.boundingBox())!.y).toBeGreaterThan(raised!.y);
  await overlay.dispatchEvent("pointermove");
  await overlay.getByRole("button", { name: "Nastavení přehrávání", exact: true }).click();
  await expect(overlay.locator(".player-settings")).toBeVisible();
  await page.waitForTimeout(3800);
  await expect(overlay).not.toHaveClass(/controls-hidden/);
  const overflow = await overlay.locator(".player-controls").evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  const settingsButton = await overlay.locator(".player-settings-toggle").boundingBox();
  const fullscreenButton = await overlay.locator(".fullscreen-action").boundingBox();
  expect(fullscreenButton!.x - settingsButton!.x - settingsButton!.width).toBeLessThanOrEqual(8);

  for (const button of await overlay.locator(".player-controls button").all()) {
    const box = await button.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await overlay.getByRole("button", { name: "Zavřít nastavení přehrávání" }).click();
  await page.screenshot({ path: `test-results/player-${test.info().project.name}.png` });
  await overlay.locator(".fullscreen-action").click();
  await overlay.dispatchEvent("pointermove");
  const maximized = await video.boundingBox();
  await expect(overlay).toHaveClass(/controls-hidden/, { timeout: 8000 });
  expect(await video.boundingBox()).toEqual(maximized);
  await overlay.dispatchEvent("pointermove");
  await overlay.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
  await expect(overlay).toHaveCount(0);
});
