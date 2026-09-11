import test from "node:test";
import assert from "node:assert/strict";
import { Throughput } from "./throughput.js";

test("the total counts everything, the speed only the averaging window", () => {
  const meter = new Throughput();
  const start = 1_000_000;
  for (let second = 0; second < 60; second += 1) meter.add("a", 1_000_000, start + second * 1000);

  const read = meter.read("a", start + 59_000);
  assert.equal(read.bytes, 60_000_000);
  assert.equal(read.rate, 1_000_000);
});

test("a stream that stopped sending falls to zero", () => {
  const meter = new Throughput();
  meter.add("a", 5_000_000, 1000);
  meter.add("a", 5_000_000, 2000);

  assert.equal(meter.read("a", 3000).rate > 0, true);
  assert.equal(meter.read("a", 120_000).rate, 0);
  assert.equal(meter.read("a", 120_000).bytes, 10_000_000);
});

test("two chunks are enough for a speed", () => {
  const meter = new Throughput();
  meter.add("a", 2_000_000, 1000);
  meter.add("a", 2_000_000, 2000);
  assert.equal(meter.read("a", 2000).rate, 2_000_000);
});

test("an unknown key is empty and forgetting clears the key", () => {
  const meter = new Throughput();
  assert.deepEqual(meter.read("nobody"), { bytes: 0, rate: 0 });

  meter.add("a", 1000);
  meter.forget("a");
  assert.deepEqual(meter.read("a"), { bytes: 0, rate: 0 });
});

test("keys are counted apart", () => {
  const meter = new Throughput();
  meter.add("a", 1000, 1000);
  meter.add("b", 3000, 1000);
  assert.equal(meter.read("a", 1000).bytes, 1000);
  assert.equal(meter.read("b", 1000).bytes, 3000);
});
