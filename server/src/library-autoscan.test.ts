import assert from "node:assert/strict";
import { test } from "node:test";
import { LibraryAutoScan, type LibraryAutoScanOpts } from "./library-autoscan.js";
import type { ScanState } from "./library-scan.js";
import type { FoundFile } from "./library.js";

const idle = (): ScanState => ({ status: "idle", total: 0, done: 0, matched: 0, skipped: 0, failed: 0, remaining: [] });
const file = (relative: string, size = 1, modified = "2026-01-01T00:00:00.000Z"): FoundFile => ({ relative, size, modified });

const harness = (overrides: Partial<LibraryAutoScanOpts> = {}) => {
  const state = { files: [file("Foo/a.mkv")], status: idle(), enabled: true, busy: false, starts: 0 };
  const auto = new LibraryAutoScan({
    enabled: () => state.enabled,
    files: async () => state.files,
    status: () => state.status,
    start: async () => { state.starts += 1; return { ...idle(), status: "running" }; },
    busy: () => state.busy,
    ...overrides,
  });
  return { auto, state };
};

test("the first check after a restart scans, an unchanged tree then does not", async () => {
  const { auto, state } = harness();
  assert.equal(await auto.check("startup"), true);
  assert.equal(state.starts, 1);
  assert.equal(await auto.check("interval"), false, "nothing changed, so the catalogues are asked nothing");
  assert.equal(state.starts, 1);
});

test("a copied file changes the fingerprint and starts a scan", async () => {
  const { auto, state } = harness();
  await auto.check("startup");
  state.files = [...state.files, file("Bar/b.mkv")];
  assert.equal(await auto.check("watch"), true);
  assert.equal(state.starts, 2);
});

test("a replaced file of another size is a change too", async () => {
  const { auto, state } = harness();
  await auto.check("startup");
  state.files = [file("Foo/a.mkv", 2)];
  assert.equal(await auto.check("interval"), true);
});

test("switched off, busy, or already scanning means no automatic run", async () => {
  const { auto, state } = harness();
  state.enabled = false;
  assert.equal(await auto.check("interval"), false);
  state.enabled = true;
  state.busy = true;
  assert.equal(await auto.check("interval"), false);
  state.busy = false;
  state.status = { ...idle(), status: "running" };
  assert.equal(await auto.check("interval"), false);
  assert.equal(state.starts, 0);
});

test("a manual scan becomes the baseline, so no automatic run repeats it", async () => {
  const { auto, state } = harness();
  await auto.remember();
  assert.equal(await auto.check("interval"), false);
  assert.equal(state.starts, 0);
});

test("a failing start is reported, not thrown, and the same tree is tried again", async () => {
  let fail = true;
  const { auto, state } = harness({
    start: async () => {
      if (fail) throw new Error("addons are down");
      state.starts += 1;
      return { status: "running", total: 0, done: 0, matched: 0, skipped: 0, failed: 0, remaining: [] };
    },
  });
  assert.equal(await auto.check("startup"), false);
  fail = false;
  assert.equal(await auto.check("interval"), true, "the unchanged tree is retried, the failure was not remembered");
  assert.equal(state.starts, 1);
});
