import assert from "node:assert/strict";
import test from "node:test";
import { MIN_SEGMENT_BYTES, planSegments, segmentCount, segmentedBytes, usableSegments } from "./download-segments.js";

const MiB = 1024 ** 2;

test("a plan covers the whole file without a gap or an overlap", () => {
  const plan = planSegments(100 * MiB, 3);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].start, 0);
  assert.equal(plan.at(-1)!.end, 100 * MiB - 1);
  for (let index = 1; index < plan.length; index += 1) assert.equal(plan[index].start, plan[index - 1].end + 1);
});

test("a file too small to be worth splitting stays in one piece", () => {
  assert.equal(planSegments(MIN_SEGMENT_BYTES * 2 - 1, 4).length, 1);
  assert.equal(planSegments(MIN_SEGMENT_BYTES * 2, 4).length, 2);
  assert.deepEqual(planSegments(0, 4), []);
});

test("the number of segments is clamped to what the transfer can use", () => {
  assert.equal(segmentCount(0), 1);
  assert.equal(segmentCount("nonsense"), 1);
  assert.equal(segmentCount(99), 8);
  assert.equal(segmentCount(3.7), 3);
});

test("a restored plan is accepted only when it still describes the same file", () => {
  const plan = planSegments(100 * MiB, 2);
  plan[0].received = 1024;
  assert.deepEqual(usableSegments(plan, 100 * MiB), plan);
  assert.equal(usableSegments(plan, 90 * MiB), undefined, "a different size means a different file");
  assert.equal(usableSegments([{ start: 0, end: 10, received: 0 }], 11), undefined, "one part is not a segmented plan");
  assert.equal(usableSegments([{ start: 0, end: 10, received: 0 }, { start: 12, end: 20, received: 0 }], 21), undefined, "a gap is not a plan");
  assert.equal(usableSegments([{ start: 0, end: 10, received: 99 }, { start: 11, end: 20, received: 0 }], 21), undefined, "a part cannot hold more than its own range");
  assert.equal(usableSegments("nonsense", 21), undefined);
});

test("received bytes are the sum of the parts", () => {
  assert.equal(segmentedBytes([{ start: 0, end: 9, received: 4 }, { start: 10, end: 19, received: 6 }]), 10);
});
