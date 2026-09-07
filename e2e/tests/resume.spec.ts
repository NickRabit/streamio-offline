import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

test("resume collection includes every existing local file and supports paging and filters", async ({ request }) => {
  const directory = path.resolve("e2e/.tmp/downloads/resume-test");
  await mkdir(directory, { recursive: true });
  try {
    for (let index = 0; index < 45; index++) {
      const relative = `resume-test/episode-${index}.mp4`;
      await writeFile(path.join(directory, `episode-${index}.mp4`), "fixture");
      expect((await request.post("/api/progress", { data: { key: `file:${relative}`, path: relative, title: `Resume episode ${index}`, position: 120, duration: 2400 } })).ok()).toBe(true);
    }
    await request.post("/api/progress", { data: { key: "file:resume-test/missing.mp4", path: "resume-test/missing.mp4", title: "Missing", position: 120, duration: 2400 } });
    const first = await (await request.get("/api/library/resume?limit=20")).json();
    expect(first.total).toBe(45);
    expect(first.items).toHaveLength(20);
    expect(first.items[0].progress.position).toBe(120);
    const last = await (await request.get("/api/library/resume?skip=40&limit=20")).json();
    expect(last.items).toHaveLength(5);
    expect(last.items.some((item: { path: string }) => first.items.some((other: { path: string }) => other.path === item.path))).toBe(false);
    const filtered = await (await request.get("/api/library/resume?query=episode%2044")).json();
    expect(filtered.total).toBe(1);
    await request.post("/api/library/favorite", { data: { path: "resume-test/episode-44.mp4", favorite: true } });
    const favorites = await (await request.get("/api/library/resume?favorites=1")).json();
    expect(favorites.total).toBe(1);
    expect(favorites.items[0].favorite).toBe(true);
  } finally {
    await request.post("/api/library/favorite", { data: { path: "resume-test/episode-44.mp4", favorite: false } });
    for (let index = 0; index < 45; index++) await request.delete(`/api/progress/${encodeURIComponent(`file:resume-test/episode-${index}.mp4`)}`);
    await request.delete(`/api/progress/${encodeURIComponent("file:resume-test/missing.mp4")}`);
    await rm(directory, { recursive: true, force: true });
  }
});
