import assert from "node:assert/strict";
import test from "node:test";
import { rankStreams, streamLanguages } from "./ranking.js";
import type { StreamItem } from "./types.js";

const stream = (parts: Partial<StreamItem>): StreamItem => ({ url: "https://a.test/x.mkv", ...parts });

test("the language comes from the bingeGroup when the text says nothing", () => {
  assert.deepEqual(streamLanguages(stream({ name: "FullHD", behaviorHints: { bingeGroup: "Webshare|CZ|1080p|" } })), ["cs"]);
});

test("quality, codec and release group fields are not languages", () => {
  assert.deepEqual(streamLanguages(stream({ name: "4K", behaviorHints: { bingeGroup: "torrentio|4k|BluRay REMUX|hevc|10bit|DV|HDR" } })), []);
  assert.deepEqual(streamLanguages(stream({ name: "2160p", behaviorHints: { bingeGroup: "com.aiostreams.viren070|realdebrid|false|2160p|BluRay|HEVC|Atmos|TrueHD|WhiteRhino" } })), []);
});

test("the infohash Torrentio falls back to is not a language", () => {
  assert.deepEqual(streamLanguages(stream({ name: "4K", behaviorHints: { bingeGroup: "torrentio|aba496ab7b4ccd69cd106585771ad411de048be3" } })), []);
});

test("what the text and the bingeGroup each say is merged", () => {
  assert.deepEqual(streamLanguages(stream({ title: "CZ dabing", behaviorHints: { bingeGroup: "Webshare|CZ,SK|720p|" } })).sort(), ["cs", "sk"]);
});

test("a source the addon marked only in the bingeGroup still ranks as preferred", () => {
  const czech = stream({ name: "czech", behaviorHints: { bingeGroup: "Webshare|CZ|1080p|", videoSize: 1e9 } });
  const english = stream({ name: "english", title: "English 1080p", behaviorHints: { videoSize: 20e9 } });
  assert.deepEqual(rankStreams([english, czech], "cs", new Map()).map((item) => item.name), ["czech", "english"]);
});
