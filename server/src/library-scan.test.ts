import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LibraryScan, type LibraryScanOpts, type ScanPauseReason } from "./library-scan.js";
import type { LibraryMetaRecord, LibrarySuggestion, TitleUnit } from "./library-match.js";
import type { MetaItem } from "./types.js";

const movie = (key: string): TitleUnit => ({ key, kind: "movie", relative: key, sampleFiles: [`${key}/a.mkv`] });
const hit = (name: string, id = "tt1"): MetaItem => ({ id, type: "movie", name, releaseInfo: "2020", poster: "http://x/p.jpg", description: "Plot" });

const waitFor = async (pred: () => boolean, ms = 2_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const harness = async (overrides: Partial<LibraryScanOpts> = {}) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stremio-scan-"));
  const store: { meta: Record<string, LibraryMetaRecord>; suggestions: Record<string, LibrarySuggestion> } = { meta: {}, suggestions: {} };
  const posters: string[] = [];
  const deleted: string[] = [];
  const searches: string[] = [];
  const frames: string[] = [];
  let busy: ScanPauseReason | undefined;
  const scan = new LibraryScan({
    dataDir,
    downloadDir: "/downloads",
    listVideos: async () => [{ relative: "Foo/a.mkv", size: 1, modified: "2026-01-01T00:00:00.000Z" }],
    titleUnits: () => [movie("Foo")],
    searchAll: async (_addons, query) => {
      searches.push(query);
      return { items: [hit(query)] };
    },
    metadata: async (_addons, type, id) => hit("Foo", id),
    addons: () => [],
    libraryMeta: () => store.meta,
    updateMeta: async (mutator) => { mutator(store.meta, store.suggestions); },
    savePoster: (key) => { posters.push(key); },
    deleteGeneratedArt: async (key) => { deleted.push(key); },
    busy: () => busy,
    pathExists: async () => true,
    gapMs: 0,
    wakeMs: 20,
    ...overrides,
  });
  return {
    dataDir, scan, store, posters, deleted, searches, frames,
    setBusy: (value: ScanPauseReason | undefined) => { busy = value; },
    close: async () => { await scan.stop(); await rm(dataDir, { recursive: true, force: true }); },
  };
};

test("a unique title auto-accepts, deletes hashed art and saves the catalog poster", async () => {
  const h = await harness();
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 1);
    assert.equal(h.store.meta.Foo?.id, "tt1");
    assert.equal(h.store.meta.Foo?.source, "scan");
    assert.equal(h.store.meta.Foo?.locked, false);
    assert.deepEqual(h.deleted, ["Foo"]);
    assert.deepEqual(h.posters, ["Foo"]);
    assert.deepEqual(h.frames, []);
  } finally { await h.close(); }
});

test("bound and locked units skip without waiting the gap", async () => {
  const h = await harness({ gapMs: 200 });
  try {
    h.store.meta.Foo = { type: "movie", id: "tt1", source: "download", locked: true };
    const started = Date.now();
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().skipped, 1);
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.searches.length, 0);
    assert.ok(Date.now() - started < 200);
  } finally { await h.close(); }
});

test("a user lock taken during search is not overwritten", async () => {
  const h = await harness({
    searchAll: async () => {
      h.store.meta.Foo = { type: "movie", id: "tt-user", source: "user", locked: true };
      return { items: [hit("Foo")] };
    },
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.store.meta.Foo?.id, "tt-user");
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.posters.length, 0);
  } finally { await h.close(); }
});

test("load retries the in-flight key still listed in remaining", async () => {
  const h = await harness({
    listVideos: async () => [
      { relative: "Foo/a.mkv", size: 1, modified: "2026-01-01T00:00:00.000Z" },
      { relative: "Bar/a.mkv", size: 1, modified: "2026-01-01T00:00:00.000Z" },
    ],
    titleUnits: () => [movie("Foo"), movie("Bar")],
    searchAll: async (_addons, query) => ({ items: [hit(query, query === "Foo" ? "tt-foo" : "tt-bar")] }),
  });
  try {
    await writeFile(path.join(h.dataDir, "library-scan.json"), JSON.stringify({
      status: "running", total: 2, done: 0, matched: 0, skipped: 0, failed: 0,
      remaining: ["Foo", "Bar"], current: "Foo",
    }));
    await h.scan.load();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 2);
    assert.equal(h.store.meta.Foo?.id, "tt-foo");
    assert.equal(h.store.meta.Bar?.id, "tt-bar");
  } finally { await h.close(); }
});

test("start while running or paused returns the current snapshot", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness({
    searchAll: async (_addons, query) => {
      await gate;
      return { items: [hit(query)] };
    },
  });
  try {
    const first = await h.scan.start();
    const second = await h.scan.start();
    assert.equal(first.status, "running");
    assert.equal(second.status, "running");
    assert.deepEqual(second.remaining, first.remaining);
    release();
    await waitFor(() => h.scan.snapshot().status === "completed");
  } finally { await h.close(); }
});

test("the scan pauses while busy and resumes when clear", async () => {
  const h = await harness();
  try {
    h.setBusy("playback");
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "paused");
    assert.equal(h.scan.snapshot().pauseReason, "playback");
    h.setBusy(undefined);
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().matched, 1);
  } finally { await h.close(); }
});

test("a second run of an already-matched library is all skips", async () => {
  const h = await harness();
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    const searches = h.searches.length;
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed" && h.scan.snapshot().skipped === 1);
    assert.equal(h.scan.snapshot().matched, 0);
    assert.equal(h.searches.length, searches);
  } finally { await h.close(); }
});

test("IMDb in the path is an exact metadata lookup without search", async () => {
  const lookups: string[] = [];
  const h = await harness({
    titleUnits: () => [movie("Show {imdb-tt123}")],
    pathExists: async () => true,
    metadata: async (_addons, type, id) => {
      lookups.push(`${type}:${id}`);
      return { id, type: "series", name: "Show", releaseInfo: "1995" };
    },
  });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.searches.length, 0);
    assert.ok(lookups.some((item) => item.endsWith(":tt123")));
    assert.equal(h.scan.snapshot().matched, 1);
  } finally { await h.close(); }
});

test("missing paths skip and persist without an addon call", async () => {
  const h = await harness({ pathExists: async () => false });
  try {
    await h.scan.start();
    await waitFor(() => h.scan.snapshot().status === "completed");
    assert.equal(h.scan.snapshot().skipped, 1);
    assert.equal(h.searches.length, 0);
    const saved = JSON.parse(await readFile(path.join(h.dataDir, "library-scan.json"), "utf8")) as { skipped: number };
    assert.equal(saved.skipped, 1);
  } finally { await h.close(); }
});
