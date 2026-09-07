import assert from "node:assert/strict";
import test from "node:test";
import { rewritePlaylist } from "./media-playlist.js";

test("rewrites variants, tracks, keys, maps, parts and segments while dropping metadata", () => {
  const uris: string[] = [];
  const output = rewritePlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="audio"
video.m3u8
#EXT-X-KEY:METHOD=AES-128,URI="key"
#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"
#EXT-X-PART:DURATION=0.5,URI="part.m4s"
#EXTINF:2,provider-canary
segment.m4s
#EXT-X-SESSION-DATA:DATA-ID="secret",URI="https://provider-canary.test"
#EXT-X-ENDLIST`, (uri) => { uris.push(uri); return `/api/media/${uris.length}`; });
  assert.deepEqual(uris, ["audio.m3u8", "video.m3u8", "key", "init.mp4", "part.m4s", "segment.m4s"]);
  assert.ok(!output.includes("provider-canary"));
  assert.ok(output.includes('#EXT-X-MAP:URI="/api/media/4",BYTERANGE="100@0"'));
});

test("unsupported or ambiguous manifest syntax fails closed", () => {
  for (const line of [
    '#EXT-X-DEFINE:NAME="host",VALUE="secret"',
    '#EXT-X-UNKNOWN:URI="https://provider.test"',
    '#EXT-X-MAP:URI="first",URI="second"',
    '#EXT-X-MAP:URI=unquoted',
    '#EXT-X-MEDIA:NAME="https://provider.test"',
    '#EXT-X-KEY:METHOD=AES-128,URI="{$secret}"',
  ]) assert.throws(() => rewritePlaylist(`#EXTM3U\n${line}`, () => "/api/media/opaque"));
});

test("oversized playlist transfers stop at the byte budget", async () => {
  const { readMediaText } = await import("./media-playlist.js");
  let canceled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(16)); },
    cancel() { canceled = true; },
  }));
  await assert.rejects(readMediaText(response, 20), /supported size/);
  assert.equal(canceled, true);
});
