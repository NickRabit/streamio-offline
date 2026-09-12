import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlayerSidecars, SIDECAR_LEAD_S } from "./player-sidecars.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const cue = (from: number, to: number, text: string) => {
  const stamp = (v: number) => `${String(Math.floor(v / 3600)).padStart(2, "0")}:${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}:${(v % 60).toFixed(3).padStart(6, "0")}`;
  return `${stamp(from)} --> ${stamp(to)}\n${text}`;
};

test("a seek past everything the reader has written starts one at the new position", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-ahead-"));
  const starts: number[] = [];
  const sidecars = new PlayerSidecars(async (args, signal) => {
    starts.push(Number(args[args.indexOf("-ss") + 1] ?? 0));
    await writeFile(args.at(-1)!, `WEBVTT\n\n${cue(3100, 3400, "line")}\n\n`);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    const args = async (start: number) => (start > 0 ? ["-ss", start.toFixed(3)] : []);
    sidecars.ensure("session", directory, 2, 3000, args);
    const revision = sidecars.revision("session");
    while (!(await sidecars.read("session", revision, 3000))) await tick();
    // Still inside what the reader has found, so it keeps going.
    sidecars.ensure("session", directory, 2, 3200, args);
    assert.equal(sidecars.revision("session"), revision);
    // An hour further on it would have to read the whole film to get there.
    sidecars.ensure("session", directory, 2, 6600, args);
    assert.notEqual(sidecars.revision("session"), revision);
    while (starts.length < 2) await tick();
    assert.deepEqual(starts, [3000, 6600]);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("seeking forward keeps the reader that is already writing those cues", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-forward-"));
  const starts: number[] = [];
  const sidecars = new PlayerSidecars(async (args) => {
    starts.push(Number(args[args.indexOf("-ss") + 1] ?? 0));
    await writeFile(args.at(-1)!, `WEBVTT\n\n${cue(3300, 5200, "line")}\n\n`);
  });
  try {
    const args = async (start: number) => (start > 0 ? ["-ss", start.toFixed(3)] : []);
    sidecars.ensure("session", directory, 2, 3000, args);
    const revision = sidecars.revision("session");
    while (!(await sidecars.read("session", revision, 3000))) await tick();
    sidecars.ensure("session", directory, 2, 3200, args);
    sidecars.ensure("session", directory, 2, 5000, args);
    assert.equal(sidecars.revision("session"), revision);
    assert.deepEqual(starts, [3000]);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("a jump back before the reader's start, or another track, begins a new one", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-back-"));
  const starts: number[] = [];
  const sidecars = new PlayerSidecars(async (args) => {
    starts.push(Number(args[args.indexOf("-ss") + 1] ?? 0));
    await writeFile(args.at(-1)!, `WEBVTT\n\n${cue(120, 125, "line")}\n\n`);
  });
  try {
    const args = async (start: number) => (start > 0 ? ["-ss", start.toFixed(3)] : []);
    sidecars.ensure("session", directory, 2, 3000, args);
    const first = sidecars.revision("session");
    while (starts.length < 1) await tick();
    sidecars.ensure("session", directory, 2, 100, args);
    const second = sidecars.revision("session");
    assert.notEqual(second, first);
    while (starts.length < 2) await tick();
    sidecars.ensure("session", directory, 3, 100, args);
    assert.notEqual(sidecars.revision("session"), second);
    while (!(await sidecars.read("session", sidecars.revision("session"), 100))) await tick();
    assert.deepEqual(starts, [3000, 100, 100], "each reader is asked for the position it was started at");
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("cues are held back until they reach past the playhead, then shifted to it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-lead-"));
  let finish = () => {};
  const sidecars = new PlayerSidecars(async (args, signal) => {
    await writeFile(args.at(-1)!, `WEBVTT\n\n${cue(3005, 3010, "near")}\n\n`);
    await new Promise<void>((resolve) => { finish = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
    await writeFile(args.at(-1)!, `WEBVTT\n\n${cue(3005, 3010, "near")}\n\n${cue(3000 + SIDECAR_LEAD_S + 5, 3000 + SIDECAR_LEAD_S + 9, "far")}\n\n`);
  });
  try {
    sidecars.ensure("session", directory, 0, 3000, async () => []);
    const revision = sidecars.revision("session");
    await tick();
    assert.equal(await sidecars.read("session", revision, 3000), undefined, "a cue that ends in five seconds is not worth attaching");
    finish();
    let cues;
    while (!(cues = await sidecars.read("session", revision, 3000))) await tick();
    assert.equal(cues.complete, true);
    assert.match(cues.text, /00:00:05\.000 --> 00:00:10\.000\nnear/);
    assert.equal(await sidecars.read("session", "someone-elses-revision", 3000), undefined);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("a partly written cue is never handed to the player", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-partial-"));
  const sidecars = new PlayerSidecars(async (args, signal) => {
    await writeFile(args.at(-1)!, `WEBVTT\n\n${cue(3100, 3200, "complete")}\n\n00:53:30.000 --> `);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    sidecars.ensure("session", directory, 0, 3000, async () => []);
    const revision = sidecars.revision("session");
    let cues;
    while (!(cues = await sidecars.read("session", revision, 3000))) await tick();
    assert.equal(cues.complete, false);
    assert.match(cues.text, /00:01:40\.000 --> 00:03:20\.000\ncomplete/);
    assert.doesNotMatch(cues.text, /00:53:30/);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("closing playback waits for the subtitle reader to stop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-stop-"));
  let active = false;
  const sidecars = new PlayerSidecars(async (_args, signal) => {
    active = true;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
    active = false;
  });
  try {
    sidecars.ensure("session", directory, 0, 0, async () => []);
    while (!active) await tick();
    await sidecars.stop("session");
    assert.equal(active, false);
    assert.equal(sidecars.revision("session"), undefined);
    assert.equal(await sidecars.read("session", undefined, 0), undefined);
  } finally { await sidecars.stop("session"); await rm(directory, { recursive: true, force: true }); }
});

test("the default extractor waits for the actual child exit after cancellation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sidecar-process-"));
  const originalPath = process.env.PATH;
  const sidecars = new PlayerSidecars();
  try {
    const executable = path.join(directory, "ffmpeg");
    await writeFile(executable, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv.at(-1) + ".pid", String(process.pid));\nsetInterval(() => {}, 1000);\n');
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath}`;
    sidecars.ensure("session", directory, 0, 0, async () => []);
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
