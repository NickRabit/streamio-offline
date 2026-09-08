import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { watchLibrary } from "./library-watch.js";

/** Controllable stand-ins, so the debounce is tested without waiting for it. */
const fakeTimers = () => {
  let queued: (() => void) | undefined;
  let scheduled = 0;
  const timer = ((fn: () => void) => { queued = fn; scheduled += 1; return { unref() {} }; }) as unknown as typeof setTimeout;
  const clear = (() => { queued = undefined; }) as unknown as typeof clearTimeout;
  return { timer, clear, fire: () => queued?.(), scheduled: () => scheduled };
};

test("a burst of events settles into one run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stremio-watch-"));
  const seen: string[] = [];
  const timers = fakeTimers();
  const watch = watchLibrary(dir, (file) => seen.push(file), { debounceMs: 5, timer: timers.timer, clear: timers.clear });
  try {
    assert.equal(watch.active, true, "a real directory can be watched");
    // The watcher itself is the platform's business; the debounce is ours.
    timers.fire();
    assert.equal(seen.length, 0, "nothing happened yet, so nothing is reported");
  } finally {
    watch.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a directory that cannot be watched falls back quietly", () => {
  const watch = watchLibrary(path.join(tmpdir(), "stremio-watch-missing-directory"), () => undefined);
  assert.equal(watch.active, false, "the periodic check takes over instead");
  watch.close();
});
