import assert from "node:assert/strict";
import test from "node:test";
import { SerialOperations } from "./playback.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("operace jedné přehrávací relace se nikdy nepřekrývají", async () => {
  const queue = new SerialOperations();
  const events: string[] = [];
  let active = 0;
  let maximum = 0;

  const operation = (name: string, delay: number) => queue.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    events.push(`${name}:start`);
    await pause(delay);
    events.push(`${name}:end`);
    active -= 1;
    return name;
  });

  const results = await Promise.all([operation("seek-1", 20), operation("track", 1), operation("seek-2", 1)]);
  assert.deepEqual(results, ["seek-1", "track", "seek-2"]);
  assert.equal(maximum, 1);
  assert.deepEqual(events, ["seek-1:start", "seek-1:end", "track:start", "track:end", "seek-2:start", "seek-2:end"]);
});

test("chybná operace nezablokuje následující seek", async () => {
  const queue = new SerialOperations();
  await assert.rejects(queue.run(async () => { throw new Error("selhání převodu"); }), /selhání převodu/);
  assert.equal(await queue.run(async () => "pokračuji"), "pokračuji");
  await queue.wait();
});
