import assert from "node:assert/strict";
import test from "node:test";
import { looksUnreachable, playlistArgsFrom } from "./probe.js";

test("the picky segment option is passed only to a build that has it", () => {
  assert.deepEqual(playlistArgsFrom("  -extension_picky   <boolean>  reject unknown extensions"), ["-allowed_extensions", "ALL", "-extension_picky", "0"]);
  // An older FFmpeg dies on an option it does not know, so it must be left out entirely.
  assert.deepEqual(playlistArgsFrom("  -allowed_extensions <string>"), ["-allowed_extensions", "ALL"]);
  assert.deepEqual(playlistArgsFrom(""), ["-allowed_extensions", "ALL"]);
});

test("a dead connection or a server error is recognised as unreachable", () => {
  assert.equal(looksUnreachable("tcp://host:443: Connection refused"), true);
  assert.equal(looksUnreachable("Server returned 404 Not Found"), true);
  assert.equal(looksUnreachable("Server returned 500 Internal Server Error"), true);
  assert.equal(looksUnreachable("Failed to resolve hostname host: Name or service not known"), true);
  assert.equal(looksUnreachable("Connection timed out"), true);
});

test("a stream the source just failed to decode is not treated as unreachable", () => {
  assert.equal(looksUnreachable("Invalid data found when processing input"), false);
  assert.equal(looksUnreachable(""), false);
});
