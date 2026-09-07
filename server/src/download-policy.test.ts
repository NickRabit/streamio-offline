import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFailure, expectedSize, HttpSourceError, IncompleteDownloadError, parseContentRange,
  retryDelayMs, SourceError, StorageError, storageHeadroom, storageMessage, storageResumeNeed,
} from "./download-policy.js";

test("network and incomplete transfers are transient", () => {
  assert.equal(classifyFailure(new Error("fetch failed")), "transient");
  assert.equal(classifyFailure(new Error("ECONNRESET")), "transient");
  assert.equal(classifyFailure(new IncompleteDownloadError(10, 100)), "transient");
  assert.equal(classifyFailure(new Error("aborted"), { stalled: true }), "transient");
  assert.equal(classifyFailure(new HttpSourceError(429, "Zdroj odpověděl HTTP 429.")), "transient");
  assert.equal(classifyFailure(new HttpSourceError(503, "Zdroj odpověděl HTTP 503.")), "transient");
  assert.equal(classifyFailure(new HttpSourceError(416, "Zdroj odpověděl HTTP 416.")), "transient");
});

test("missing or forbidden sources are not retried on the same URL", () => {
  assert.equal(classifyFailure(new HttpSourceError(404, "Zdroj odpověděl HTTP 404.")), "source");
  assert.equal(classifyFailure(new HttpSourceError(403, "Zdroj odpověděl HTTP 403.")), "source");
  assert.equal(classifyFailure(new SourceError("Nenašel se žádný přímo stažitelný zdroj.")), "source");
  assert.equal(classifyFailure(new Error("Zdroj odpověděl HTTP 410.")), "source");
});

test("disk errors halt the queue instead of hopping to the next source", () => {
  const enospc = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  assert.equal(classifyFailure(enospc), "storage");
  assert.equal(classifyFailure(new StorageError("Na disku není místo.", "ENOSPC")), "storage");
  assert.equal(classifyFailure(Object.assign(new Error("write"), { code: "EDQUOT" })), "storage");
  assert.equal(classifyFailure(Object.assign(new Error("read"), { code: "ESTALE" })), "storage");
  assert.equal(storageMessage(enospc), "Na disku není místo.");
});

test("Content-Range start and total are parsed", () => {
  assert.deepEqual(parseContentRange("bytes 100-199/1000"), { start: 100, end: 199, total: 1000 });
  assert.deepEqual(parseContentRange("bytes 0-9/*"), { start: 0, end: 9, total: undefined });
  assert.equal(parseContentRange("bytes */1000"), undefined);
  assert.equal(parseContentRange("unrelated"), undefined);
});

test("headroom is 1 GiB on a large volume and 2 % on a small one", () => {
  const MiB = 1024 ** 2;
  const GiB = 1024 ** 3;
  assert.equal(storageHeadroom(8 * 1024 * GiB), GiB);
  assert.equal(storageHeadroom(10 * GiB), 256 * MiB);
  assert.equal(storageHeadroom(20 * GiB), Math.floor(20 * GiB * 0.02));
  assert.equal(storageResumeNeed(8 * 1024 * GiB, 0), GiB + 256 * MiB);
});

test("retry delay grows and honours Retry-After up to five minutes", () => {
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(2), 8_000);
  assert.equal(retryDelayMs(3), 30_000);
  assert.equal(retryDelayMs(1, 1_000), 2_000);
  assert.equal(retryDelayMs(1, 10_000), 10_000);
  assert.equal(retryDelayMs(1, 10 * 60_000), 5 * 60_000);
});

test("the first positive candidate is the expected size", () => {
  assert.equal(expectedSize(0, undefined, 50), 50);
  assert.equal(expectedSize(undefined, 0), undefined);
});
