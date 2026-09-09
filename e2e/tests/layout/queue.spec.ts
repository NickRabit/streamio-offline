import { expect, test } from "@playwright/test";

test("queue pages, sorts and filters without overflowing the viewport", async ({ page }, testInfo) => {
  const jobs = Array.from({ length: 45 }, (_, index) => ({
    id: `queue-${index}`, title: `Queue ${String(index).padStart(2, "0")} long title for responsive layouts`,
    target: `films/a-long-folder/queue-${index}.mp4`, order: index,
    status: index % 2 ? "paused" : "completed", received: 1024, total: 1024, speed: 0,
    createdAt: "2026-09-01T10:00:00Z", startedAt: "2026-09-02T10:00:00Z",
    completedAt: index % 2 ? undefined : "2026-09-02T10:01:30Z", updatedAt: "2026-09-02T10:01:30Z",
  }));
  await page.route("**/api/downloads", (route) => route.fulfill({ json: { jobs, halt: null } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Stahování", exact: true }).click();
  const rows = page.locator(".download-row");
  await expect(rows).toHaveCount(20);
  await page.getByRole("button", { name: "Další", exact: true }).click();
  await expect(rows.first()).toContainText("Queue 20");
  await page.getByLabel("Řadit podle", { exact: true }).selectOption("titleSort");
  await page.getByLabel("Směr", { exact: true }).selectOption("desc");
  await expect(rows.first()).toContainText("Queue 44");
  await page.getByLabel("Stav", { exact: true }).selectOption("completed");
  await page.getByLabel("Položek na stránce").selectOption("50");
  await expect(rows).toHaveCount(23);
  await page.getByLabel("Filtrovat datum").selectOption("completedAt");
  await page.getByLabel("Od", { exact: true }).fill("2026-09-03");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("Žádné odpovídající položky")).toBeVisible();
  await page.getByRole("button", { name: "Zrušit filtry" }).click();
  await page.getByLabel("Hledat název nebo cestu").fill("Queue 00");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".queue-times")).toContainText("Začátek");
  await page.screenshot({ path: `e2e/.tmp/queue-${testInfo.project.name}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  for (const control of await page.locator(".queue-tools input, .queue-tools select, .queue-pagination button").all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
});
