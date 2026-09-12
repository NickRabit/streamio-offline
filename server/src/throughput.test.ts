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

test("busy streams preserve the window anchor through repeated compaction and idle gaps", () => {
  const meter = new Throughput();
  const history: { at: number; bytes: number }[] = [];
  let total = 0;
  let now = 100_000;
  for (let index = 0; index < 40_000; index++) {
    now += index % 7 === 0 ? 0 : 17;
    const bytes = 100 + index % 4096;
    total += bytes;
    history.push({ at: now, bytes: total });
    meter.add("film", bytes, now);
    if (index % 997 === 0 || index === 39_999) {
      const anchor = history.findLast((sample) => sample.at < now - 20_000) ?? history[0];
      const span = now - anchor.at;
      assert.deepEqual(meter.read("film", now), { bytes: total, rate: span ? Math.round((total - anchor.bytes) * 1000 / span) : 0 });
    }
  }
  assert.deepEqual(meter.read("film", now + 60_000), { bytes: total, rate: 0 });
  meter.add("film", 1000, now + 61_000);
  assert.deepEqual(meter.read("film", now + 61_000), { bytes: total + 1000, rate: Math.round(1000 / 61) });
});

test("a burst inside one millisecond reads the same as the one write it stands for", () => {
  const split = new Throughput(), whole = new Throughput();
  split.add("film", 1000, 1000); whole.add("film", 1000, 1000);
  for (let write = 0; write < 500; write++) split.add("film", 64, 21_000);
  whole.add("film", 500 * 64, 21_000);
  assert.deepEqual(split.read("film", 21_000), whole.read("film", 21_000));
  assert.equal(split.read("film", 21_000).bytes, 1000 + 500 * 64);
});
