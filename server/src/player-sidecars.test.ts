import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlayerSidecars } from "./player-sidecars.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("repeated seeks cancel obsolete subtitle readers and publish only the latest revision", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-seek-"));
  const calls: { signal: AbortSignal; finish: () => void }[] = [];
  let active = 0;
  let maximum = 0;
  const errors: unknown[] = [];
  const sidecars = new PlayerSidecars(async (args, signal) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => {
      calls.push({ signal, finish: resolve });
      signal.addEventListener("abort", () => { setTimeout(resolve, 25); }, { once: true });
    });
    // Simulate an obsolete process finishing despite a late cancellation.
    await writeFile(args.at(-1)!, args[0]);
    active--;
  }, (_id, error) => errors.push(error));
  try {
    sidecars.start("session", directory, async () => ["old"]);
    while (!calls.length) await tick();
    const oldRevision = sidecars.revision("session");
    sidecars.start("session", directory, async () => ["new"]);
    assert.equal(calls[0].signal.aborted, true);
    while (calls.length < 2) await tick();
    assert.equal(sidecars.file("session"), undefined);
    calls[1].finish();
    while (!sidecars.file("session")) await tick();
    assert.equal(maximum, 1);
    assert.equal(sidecars.file("session", oldRevision), undefined);
    assert.equal(await readFile(sidecars.file("session")!, "utf8"), "new");
    assert.deepEqual(errors, []);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("closing playback waits for the subtitle reader to stop", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-stop-"));
  let active = false;
  const sidecars = new PlayerSidecars(async (_args, signal) => {
    active = true;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
    active = false;
  });
  try {
    sidecars.start("session", directory, async () => []);
    while (!active) await tick();
    await sidecars.stop("session");
    assert.equal(active, false);
    assert.equal(sidecars.file("session"), undefined);
    assert.equal(sidecars.revision("session"), undefined);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("the default extractor waits for the actual child exit after cancellation", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-process-"));
  const originalPath = process.env.PATH;
  const sidecars = new PlayerSidecars();
  try {
    const executable = path.join(directory, "ffmpeg");
    await writeFile(executable, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv.at(-1) + ".pid", String(process.pid));\nsetInterval(() => {}, 1000);\n');
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath}`;
    sidecars.start("session", directory, async () => []);
    const marker = path.join(directory, `sidecar-${sidecars.revision("session")}.vtt.pid`);
    let pid = 0;
    while (!pid) { pid = Number(await readFile(marker, "utf8").catch(() => "0")); await tick(); }
    await sidecars.stop("session");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await sidecars.stop("session");
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});
