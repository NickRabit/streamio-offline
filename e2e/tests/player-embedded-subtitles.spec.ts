import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const folder = path.resolve("e2e/.tmp/downloads/Vestavene titulky");
const relative = "Vestavene titulky/epizoda.mkv";

// A film with a real subtitle stream, built from the sample so no binary fixture is stored.
test.beforeAll(async () => {
  await mkdir(folder, { recursive: true });
  const srt = path.join(folder, "cues.srt");
  const stamp = (value: number) => `00:${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")},000`;
  await writeFile(srt, Array.from({ length: 18 }, (_, i) => `${i + 1}\n${stamp(i * 10)} --> ${stamp(i * 10 + 9)}\nTitulek ${i + 1}\n`).join("\n"));
  await promisify(execFile)("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-stream_loop", "89", "-i", path.resolve("e2e/fixtures/media/sample.mp4"),
    "-f", "srt", "-i", srt, "-map", "0:v", "-map", "0:a", "-map", "1:0", "-c", "copy", "-t", "180",
    "-y", path.join(folder, "epizoda.mkv"),
  ]);
});

test("switching on an embedded track serves its cues, and a seek shifts them", async ({ request }) => {
  const source = await (await request.post("/api/library/source", { data: { path: relative } })).json();
  const started = await (await request.post("/api/playback", { data: { sourceId: source.sourceId, capabilities: { h264: true, aac: true }, time: 0, subtitleIds: [] } })).json();
  // English cues against a Czech preference: the server offers the track without switching it on.
  expect(started.subtitleTracks).toHaveLength(1);
  expect(started.subtitleTrack).toBeNull();
  expect(started.sidecarUrl).toBeUndefined();

  const switched = await (await request.post(`/api/playback/${started.id}/track`, { data: { subtitle: 0, time: 0 } })).json();
  expect(switched.sidecarUrl).toMatch(/sidecar\.vtt\?revision=[0-9a-f-]+&offset=0\.000$/);

  const cues = async (url: string) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await request.get(url);
      if (response.ok()) return { text: await response.text(), complete: response.headers()["x-sidecar-complete"] };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`the sidecar at ${url} never answered`);
  };

  const first = await cues(switched.sidecarUrl);
  expect(first.text).toContain("WEBVTT");
  expect(first.text).toMatch(/00:00\.023 --> 00:09\.023\nTitulek 1/);

  // Half an hour in the film starts at zero again, so the cues have to move with it.
  const sought = await (await request.post(`/api/playback/${started.id}/seek`, { data: { time: 100 } })).json();
  expect(sought.sidecarUrl).toMatch(/&offset=100\.000$/);
  const shifted = await cues(sought.sidecarUrl);
  expect(shifted.text).toMatch(/Titulek 11/);
  expect(shifted.text).not.toMatch(/Titulek 1\n/);
  expect(shifted.text).toMatch(/00:00:00\.023 --> 00:00:09\.023\nTitulek 11/);
  // The same reader serves the new position: seeking must not start FFmpeg again.
  expect(/revision=([0-9a-f-]+)/.exec(sought.sidecarUrl)?.[1]).toBe(/revision=([0-9a-f-]+)/.exec(switched.sidecarUrl)?.[1]);

  await request.delete(`/api/playback/${started.id}`);
});
