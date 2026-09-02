import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DownloadQueue } from "./downloads.js";

const MB = 1024 * 1024;
const TOTAL = 120 * MB;
const DROP_AFTER = 51 * MB;

/** Odešle data po megabajtu a respektuje protitlak, ať se test nezalkne v paměti. */
const send = async (res: NodeJS.WritableStream, bytes: number) => {
  const chunk = Buffer.alloc(MB);
  for (let sent = 0; sent < bytes; sent += MB) {
    if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
  }
};

/** Server, který první přenos po DROP_AFTER bajtech utne, a teprve navázaný dokončí. */
const flakyServer = () => new Promise<{ server: Server; port: number; drops: () => number }>((resolve) => {
  let drops = 0;
  const server = createServer(async (req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(TOTAL), "content-type": "video/mp4" });
      await send(res, DROP_AFTER);
      drops += 1;
      req.socket.destroy();
      return;
    }
    const offset = Number(range[1]);
    res.writeHead(206, { "content-length": String(TOTAL - offset), "content-range": `bytes ${offset}-${TOTAL - 1}/${TOTAL}` });
    await send(res, TOTAL - offset);
    res.end();
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, drops: () => drops }));
});

test("po výpadku a rozjetém přenosu se rozpočet pokusů vrátí", async () => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port, drops } = await flakyServer();
  try {
    const data = path.join(directory, "data"); const downloads = path.join(directory, "downloads");
    const manager = new DownloadQueue(() => 1, () => 1, data, downloads);
    await manager.load();
    await manager.add("Pokus", { url: `http://127.0.0.1:${port}/video.mp4` });

    const deadline = Date.now() + 60_000; let job = manager.list()[0];
    while (job.status !== "completed" && job.status !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = manager.list()[0];
    }

    assert.equal(drops(), 1, "server měl spojení utnout právě jednou");
    assert.equal(job.status, "completed", `stahování mělo dojet, stav: ${job.status} ${job.error ?? ""}`);
    assert.equal(job.retryCount, 0, "po rozjetém přenosu má být rozpočet pokusů zase plný");
    assert.equal((await stat(path.join(downloads, job.target))).size, TOTAL);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** Server, který měří, kolik přenosů z něj běželo současně. */
const countingServer = (bytes = 2 * MB) => new Promise<{ server: Server; port: number; peak: () => number }>((resolve) => {
  let inflight = 0; let peak = 0;
  const server = createServer(async (_req, res) => {
    inflight += 1; peak = Math.max(peak, inflight);
    res.writeHead(200, { "content-length": String(bytes), "content-type": "video/mp4" });
    await new Promise((done) => setTimeout(done, 300));
    await send(res, bytes);
    res.end();
    inflight -= 1;
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, peak: () => peak }));
});

const runThree = async (perProvider: number) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port, peak } = await countingServer();
  try {
    const queue = new DownloadQueue(() => 4, () => perProvider, path.join(directory, "data"), path.join(directory, "downloads"));
    await queue.load();
    for (const name of ["Prvni", "Druhy", "Treti"]) await queue.add(name, { url: `http://127.0.0.1:${port}/${name}.mp4` });
    const deadline = Date.now() + 30_000;
    while (queue.list().some((job) => job.status !== "completed" && job.status !== "failed") && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.deepEqual(queue.list().map((job) => job.status), ["completed", "completed", "completed"]);
    return peak();
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("z jednoho poskytovatele běží jen povolený počet přenosů", async () => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  assert.equal(await runThree(1), 1, "při jedničce se přenosy z jednoho hosta nesmí potkat");
});

test("vyšší limit na poskytovatele přenosy zase pustí souběžně", async () => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  assert.equal(await runThree(2), 2, "při dvojce mají běžet právě dva najednou");
});
