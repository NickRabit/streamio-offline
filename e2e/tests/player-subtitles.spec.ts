import { expect, test } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

test("embedded subtitle URLs load directly and a subtitle error never stops the video", async ({ page, request }) => {
  await request.get(new URL("/proxy-control?mode=browser", addonManifest).href);
  let id = "";
  await page.route("**/api/playback", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    id = session.id;
    await route.fulfill({ response, json: { ...session, sidecarUrl: `/api/playback/${id}/sidecar.vtt?revision=test&offset=0.000` } });
  });
  let complete = false;
  await page.route("**/sidecar.vtt?revision=test**", (route) => route.fulfill({
    contentType: "text/vtt", headers: { "x-sidecar-complete": complete ? "1" : "0", "x-sidecar-coverage": "600" },
    body: `WEBVTT\n\n00:00:00.000 --> 00:01:00.000\n${complete ? "Whole subtitle" : "Embedded subtitle"}\n`,
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  await catalog.selectOption((await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value"))!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();
  const video = page.locator("video");
  await expect(video).toHaveAttribute("disableRemotePlayback", "");
  await expect(video).toHaveAttribute("x-webkit-airplay", "deny");
  await expect(page.locator(".airplay-toggle")).toHaveCount(0);
  await expect(video.locator("track")).toHaveAttribute("src", /sidecar\.vtt\?revision=test&offset=0\.000&pass=0$/);
  await expect(page.locator(".player-subtitles")).toHaveText("Embedded subtitle");
  // The reader finishes behind the playhead; the track is attached again with everything it found.
  complete = true;
  await expect(video.locator("track")).toHaveAttribute("src", /&pass=1$/, { timeout: 15_000 });
  await expect(page.locator(".player-subtitles")).toHaveText("Whole subtitle");
  await video.locator("track").dispatchEvent("error", { bubbles: false });
  await expect(page.locator(".player-error")).toHaveCount(0);
  expect((await request.post(`/api/playback/${id}/ping`)).status()).toBe(204);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Zavřít přehrávač", exact: true }).click();
  await request.get(new URL("/proxy-control?mode=video", addonManifest).href);
});
