import assert from "node:assert/strict";
import test from "node:test";
import { RangeCache } from "./range-cache.js";

const range = (length: number, complete = true) => ({ status: 206, headers: { "content-length": String(length) }, bytes: Buffer.alloc(length, 1), complete });

test("what one conversion read at the start of a film, the next one does not fetch again", () => {
  const cache = new RangeCache();
  assert.equal(cache.get("film", "bytes=0-"), undefined);
  cache.put("film", "bytes=0-", range(1024));
  assert.equal(cache.get("film", "bytes=0-")?.bytes.length, 1024);
  // The index at the end is the other half of it, and a different position is not a hit.
  cache.put("film", "bytes=21767391168-", range(2048));
  assert.equal(cache.get("film", "bytes=21767391168-")?.bytes.length, 2048);
  assert.equal(cache.get("film", "bytes=500-"), undefined);
  assert.equal(cache.get("another film", "bytes=0-"), undefined);
});

test("the film itself is not kept, only the ends", () => {
  const cache = new RangeCache(1024);
  cache.put("film", "bytes=0-", range(4096));
  assert.equal(cache.get("film", "bytes=0-"), undefined, "a read that long is the picture, not an index");
  cache.put("film", "bytes=0-", range(0));
  assert.equal(cache.get("film", "bytes=0-"), undefined);
});

test("the oldest reads go when there is no room, and stale ones expire", () => {
  let now = 0;
  const cache = new RangeCache(1024, 2048, 60_000, () => now);
  cache.put("a", "bytes=0-", range(1024));
  cache.put("b", "bytes=0-", range(1024));
  cache.put("c", "bytes=0-", range(1024));
  assert.equal(cache.get("a", "bytes=0-"), undefined, "the oldest made room for the newest");
  assert.equal(cache.get("c", "bytes=0-")?.bytes.length, 1024);
  assert.ok(cache.size <= 2048);

  now += 60_001;
  assert.equal(cache.get("c", "bytes=0-"), undefined, "an hour-old index is not worth trusting");
});

test("a source that is gone takes its reads with it", () => {
  const cache = new RangeCache();
  cache.put("film", "bytes=0-", range(1024));
  cache.put("film", "bytes=99-", range(1024));
  cache.put("other", "bytes=0-", range(1024));
  cache.forget("film");
  assert.equal(cache.get("film", "bytes=0-"), undefined);
  assert.equal(cache.get("film", "bytes=99-"), undefined);
  assert.equal(cache.get("other", "bytes=0-")?.bytes.length, 1024);
  assert.equal(cache.size, 1024);
});

test("an answer to one range is never handed over for another", () => {
  const cache = new RangeCache();
  cache.put("film", "bytes=0-", range(4096));
  assert.equal(cache.get("film", "bytes=0-31"), undefined, "asking for thirty-two bytes is a different question");
  assert.equal(cache.get("film", "")?.bytes.length, undefined);
  assert.equal(cache.get("film", "bytes=0-")?.bytes.length, 4096);
});
