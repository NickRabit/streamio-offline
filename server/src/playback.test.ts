import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackManager, SerialOperations } from "./playback.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("operace jedné přehrávací relace se nikdy nepřekrývají", async () => {
  const queue = new SerialOperations();
  const events: string[] = [];
  let active = 0;
  let maximum = 0;

  const operation = (name: string, delay: number) => queue.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    events.push(`${name}:start`);
    await pause(delay);
    events.push(`${name}:end`);
    active -= 1;
    return name;
  });

  const results = await Promise.all([operation("seek-1", 20), operation("track", 1), operation("seek-2", 1)]);
  assert.deepEqual(results, ["seek-1", "track", "seek-2"]);
  assert.equal(maximum, 1);
  assert.deepEqual(events, ["seek-1:start", "seek-1:end", "track:start", "track:end", "seek-2:start", "seek-2:end"]);
});

test("chybná operace nezablokuje následující seek", async () => {
  const queue = new SerialOperations();
  await assert.rejects(queue.run(async () => { throw new Error("selhání převodu"); }), /selhání převodu/);
  assert.equal(await queue.run(async () => "pokračuji"), "pokračuji");
  await queue.wait();
});

test("Synology bez VAAPI scalingu dekóduje na CPU a kóduje přes GPU", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  manager.vaapiDevice = "/dev/dri/renderD128";
  manager.vaapiScaling = false;
  manager.vaapiBitrate = false;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, eac3: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "eac3" },
      audioTracks: [{ codec: "eac3" }],
      subtitleTracks: [],
    },
    quality: 720,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, "/tmp/output", true) as string[];
  assert.deepEqual(args.slice(args.indexOf("-init_hw_device"), args.indexOf("-init_hw_device") + 4), [
    "-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va",
  ]);
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_vaapi");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-qp") + 1], "23");
});

test("remux dál kopíruje kompatibilní video i zvuk", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, eac3: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "eac3" },
      audioTracks: [{ codec: "eac3" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "copy");
});

test("textové titulky za odfiltrovanou PGS stopou používají skutečný index", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { h264: true, aac: true },
    info: {
      video: { codec: "h264" },
      audio: { codec: "aac" },
      audioTracks: [{ index: 0, codec: "aac" }],
      // 0:s:0 was PGS and probe() filtered it out. The surviving text track is 0:s:1.
      subtitleTracks: [{ index: 1, codec: "subrip", language: "cs" }],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: 1,
  };

  assert.equal(manager.preferredSubtitle(session.info.subtitleTracks, "cs"), 1);
  const args = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.deepEqual(args.slice(args.indexOf("-map", args.indexOf("-map") + 1), args.indexOf("-map", args.indexOf("-map") + 1) + 4), [
    "-map", "0:a:0?", "-map", "0:s:1?",
  ]);
});

test("seek s kopírovaným AC3 zvukem jej převede do AAC pro fMP4 init segment", () => {
  const manager = new PlaybackManager("/tmp/test-playback") as any;
  const session = {
    stream: { url: "https://example.test/movie.mkv" },
    capabilities: { hevc: true, ac3: true },
    info: {
      video: { codec: "hevc" },
      audio: { codec: "ac3" },
      audioTracks: [{ index: 0, codec: "ac3" }],
      subtitleTracks: [],
    },
    quality: null,
    audioTrack: 0,
    subtitleTrack: null,
  };

  const initial = manager.args(session, 0, "/tmp/output", false) as string[];
  assert.equal(initial[initial.indexOf("-c:a") + 1], "copy");
  const seeked = manager.args(session, 2369, "/tmp/output", false) as string[];
  const audio = seeked.indexOf("-c:a");
  assert.deepEqual(seeked.slice(audio, audio + 6), ["-c:a", "aac", "-ac", "2", "-b:a", "160k"]);
});
