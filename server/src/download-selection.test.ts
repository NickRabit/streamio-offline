import assert from "node:assert/strict";
import test from "node:test";
import { selectDownloadSource } from "./download-selection.js";
import type { DownloadSelection } from "./downloads.js";
import type { MediaInfo } from "./probe.js";
import type { StreamItem } from "./types.js";

const selection = (overrides: Partial<DownloadSelection> = {}): DownloadSelection => ({
  addonKeys: ["first", "second"], sourceStrategy: "priority", audioLanguage: "cs", fallbackAudioLanguage: "en",
  subtitleMode: "off", targetSettings: { subfolder: "", layout: "structured" }, ...overrides,
});
const stream = (url: string, addonKey: string, size?: number): StreamItem => ({ url, addonKey, behaviorHints: { filename: "episode.mkv", videoSize: size } });
const info = (languages: string[], subtitleLanguages: string[] = []): MediaInfo => ({
  container: "matroska", video: { codec: "h264" },
  audioTracks: languages.map((language, index) => ({ index, codec: "aac", language })),
  subtitleTracks: subtitleLanguages.map((language, index) => ({ index, codec: "subrip", language })),
});

test("primary audio wins even when an earlier source contains the fallback", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  const checked: string[] = [];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection(), tried: [],
    inspect: async (item) => { checked.push(item.url!); return item.addonKey === "first" ? info(["en"]) : info(["cs"]); },
  });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.audioLanguage, "cs");
  assert.equal(chosen?.resolution.fallbackUsed, false);
  assert.equal(checked.length, 2);
});

test("fallback audio is used only after every candidate was checked", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  let checked = 0;
  const chosen = await selectDownloadSource({ candidates, subtitles: [], selection: selection(), tried: [], inspect: async () => { checked += 1; return info(["en"]); } });
  assert.equal(chosen?.stream.addonKey, "first");
  assert.equal(chosen?.resolution.fallbackUsed, true);
  assert.equal(chosen?.resolution.checkedCandidates, 2);
  assert.equal(checked, 2);
});

test("addon priority decides between equally suitable sources", async () => {
  const candidates = [stream("https://second.test/episode.mkv", "second"), stream("https://first.test/episode.mkv", "first")];
  const chosen = await selectDownloadSource({ candidates, subtitles: [], selection: selection(), tried: [], inspect: async () => info(["cs"]) });
  assert.equal(chosen?.stream.addonKey, "first");
  assert.equal(chosen?.resolution.checkedCandidates, 1);
});

test("largest strategy ignores addon priority", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first", 300e6), stream("https://two.test/episode.mkv", "second", 1e9)];
  const chosen = await selectDownloadSource({ candidates, subtitles: [], selection: selection({ sourceStrategy: "largest" }), tried: [], inspect: async () => info(["cs"]) });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.checkedCandidates, 1);
});

test("largest strategy compares an episode size instead of its torrent pack size", async () => {
  const pack = { ...stream("https://pack.test/episode.mkv", "first"), title: "Complete pack 86 GB\nEpisode 4.01 GB" };
  const single = { ...stream("https://single.test/episode.mkv", "second"), title: "Episode 5 GB" };
  const chosen = await selectDownloadSource({ candidates: [pack, single], subtitles: [], selection: selection({ sourceStrategy: "largest" }), tried: [], inspect: async () => info(["cs"]) });
  assert.equal(chosen?.stream.url, "https://single.test/episode.mkv");
});

test("required subtitles reject a source while optional subtitles do not", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first")];
  const inspect = async () => info(["cs"]);
  const required = await selectDownloadSource({ candidates, subtitles: [], selection: selection({ subtitleMode: "required", subtitleLanguage: "cs" }), tried: [], inspect });
  assert.equal(required, undefined);
  const optional = await selectDownloadSource({ candidates, subtitles: [], selection: selection({ subtitleMode: "optional", subtitleLanguage: "cs" }), tried: [], inspect });
  assert.equal(optional?.resolution.subtitleStatus, "missing");
});

test("optional subtitles never displace a larger source with primary audio", async () => {
  const candidates = [stream("https://large.test/episode.mkv", "first", 1e9), stream("https://small.test/episode.mkv", "first", 300e6)];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection({ sourceStrategy: "largest", subtitleMode: "optional", subtitleLanguage: "cs" }), tried: [],
    inspect: async (item) => item.url!.includes("small") ? info(["cs"], ["cs"]) : info(["cs"]),
  });
  assert.equal(chosen?.stream.url, "https://large.test/episode.mkv");
  assert.equal(chosen?.resolution.subtitleStatus, "missing");
});

test("embedded subtitles break ties only when fallback audio is needed", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection({ subtitleMode: "optional", subtitleLanguage: "cs" }), tried: [],
    inspect: async (item) => item.addonKey === "first" ? info(["en"]) : info(["en"], ["cs"]),
  });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.fallbackUsed, true);
  assert.equal(chosen?.resolution.subtitleSource, "embedded");
});

test("primary audio without subtitles beats fallback audio with embedded subtitles", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [], selection: selection({ subtitleMode: "optional", subtitleLanguage: "cs" }), tried: [],
    inspect: async (item) => item.addonKey === "first" ? info(["en"], ["cs"]) : info(["cs"]),
  });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.fallbackUsed, false);
  assert.equal(chosen?.resolution.subtitleStatus, "missing");
});

test("an addon subtitle can satisfy the required language", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first")];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [{ url: "https://subs.test/episode.srt", lang: "cs" }],
    selection: selection({ subtitleMode: "required", subtitleLanguage: "cs" }), tried: [], inspect: async () => info(["cs"]),
  });
  assert.equal(chosen?.resolution.subtitleSource, "addon");
  assert.equal(chosen?.subtitle?.url, "https://subs.test/episode.srt");
});

test("primary subtitles win over an earlier subtitle fallback", async () => {
  const candidates = [stream("https://one.test/episode.mkv", "first"), stream("https://two.test/episode.mkv", "second")];
  const chosen = await selectDownloadSource({
    candidates, subtitles: [],
    selection: selection({ subtitleMode: "required", subtitleLanguage: "cs", fallbackSubtitleLanguage: "en" }),
    tried: [], inspect: async (item) => item.addonKey === "first" ? info(["cs"], ["en"]) : info(["cs"], ["cs"]),
  });
  assert.equal(chosen?.stream.addonKey, "second");
  assert.equal(chosen?.resolution.subtitleLanguage, "cs");
});
