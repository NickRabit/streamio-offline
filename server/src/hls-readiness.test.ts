import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { waitForHlsOutput } from "./playback.js";

const playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg-0.m4s\n';

test("a slow NAS may publish the playlist before the init file is ready", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hls-ready-"));
  try {
    await writeFile(path.join(directory, "index-0.m3u8"), playlist);
    await writeFile(path.join(directory, "init.mp4"), "");
    await writeFile(path.join(directory, "seg-0.m4s"), "segment");
    const waiting = waitForHlsOutput(directory, () => false, () => false, 1000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(path.join(directory, "init.mp4"), "init");
    assert.equal(await waiting, playlist);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing HLS files use the real timeout instead of exhausting a tight retry loop", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hls-timeout-"));
  try {
    await writeFile(path.join(directory, "index-0.m3u8"), playlist);
    const started = Date.now();
    assert.equal(await waitForHlsOutput(directory, () => false, () => false, 150), undefined);
    assert.ok(Date.now() - started >= 150);
    assert.equal(await waitForHlsOutput(directory, () => true, () => false), undefined);
    assert.equal(await waitForHlsOutput(directory, () => false, () => true), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
