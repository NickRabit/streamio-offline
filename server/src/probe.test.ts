import assert from "node:assert/strict";
import test from "node:test";
import { playlistArgsFrom } from "./probe.js";

test("the picky segment option is passed only to a build that has it", () => {
  assert.deepEqual(playlistArgsFrom("  -extension_picky   <boolean>  reject unknown extensions"), ["-allowed_extensions", "ALL", "-extension_picky", "0"]);
  // An older FFmpeg dies on an option it does not know, so it must be left out entirely.
  assert.deepEqual(playlistArgsFrom("  -allowed_extensions <string>"), ["-allowed_extensions", "ALL"]);
  assert.deepEqual(playlistArgsFrom(""), ["-allowed_extensions", "ALL"]);
});
