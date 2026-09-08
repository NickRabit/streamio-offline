import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtworkQueue } from "./artwork.js";

test("ArtworkQueue.run with the same key twice chains the second task", async () => {
  const queue = new ArtworkQueue();
  const order: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  queue.run("dir:Foo", async () => { order.push(1); await gate; order.push(2); });
  const second = queue.run("dir:Foo", async () => { order.push(3); });
  release();
  await second;
  assert.deepEqual(order, [1, 2, 3]);
});
