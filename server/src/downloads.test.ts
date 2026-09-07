import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { DownloadQueue } from "./downloads.js";
import { defaultDownloadSettings } from "./naming.js";

const MB = 1024 * 1024;
const GiB = 1024 ** 3;
const TOTAL = 120 * MB;
const DROP_AFTER = 51 * MB;

process.env.ALLOW_PRIVATE_ADDONS = "1";

const send = async (res: NodeJS.WritableStream, bytes: number) => {
  const chunk = Buffer.alloc(Math.min(MB, bytes));
  for (let sent = 0; sent < bytes; ) {
    const size = Math.min(chunk.length, bytes - sent);
    const piece = size === chunk.length ? chunk : chunk.subarray(0, size);
    if (!res.write(piece)) await new Promise((resolve) => res.once("drain", resolve));
    sent += size;
  }
};

const waitFor = async (queue: DownloadQueue, predicate: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${JSON.stringify(queue.snapshot())}`);
};

const tempQueue = async (hooks: ConstructorParameters<typeof DownloadQueue>[4] = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const queue = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), path.join(directory, "downloads"), {
    retryDelay: () => 30,
    stallInitialMs: 5_000,
    stallTransferMs: 5_000,
    ...hooks,
  });
  await queue.load();
  return { directory, queue, downloads: path.join(directory, "downloads") };
};

const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => new Promise<{ server: Server; port: number }>((resolve) => {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
});

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const { server, port, drops } = await flakyServer();
  const manager = new DownloadQueue(() => 1, () => 1, path.join(directory, "data"), path.join(directory, "downloads"));
  try {
    await manager.load();
    await manager.add("Pokus", { url: `http://127.0.0.1:${port}/video.mp4` });
    await waitFor(manager, () => {
      const job = manager.list()[0];
      return job.status === "completed" || job.status === "failed";
    }, 60_000);
    const job = manager.list()[0];
    assert.equal(drops(), 1, "server měl spojení utnout právě jednou");
    assert.equal(job.status, "completed", `stahování mělo dojet, stav: ${job.status} ${job.error ?? ""}`);
    assert.equal(job.retryCount, 0, "po rozjetém přenosu má být rozpočet pokusů zase plný");
    assert.equal((await stat(path.join(directory, "downloads", job.target))).size, TOTAL);
  } finally {
    manager.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
  const queue = new DownloadQueue(() => 4, () => perProvider, path.join(directory, "data"), path.join(directory, "downloads"));
  try {
    await queue.load();
    for (const name of ["Prvni", "Druhy", "Treti"]) await queue.add(name, { url: `http://127.0.0.1:${port}/${name}.mp4` });
    await waitFor(queue, () => queue.list().every((job) => job.status === "completed" || job.status === "failed"), 30_000);
    assert.deepEqual(queue.list().map((job) => job.status), ["completed", "completed", "completed"]);
    return peak();
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("z jednoho poskytovatele běží jen povolený počet přenosů", async () => {
  assert.equal(await runThree(1), 1, "při jedničce se přenosy z jednoho hosta nesmí potkat");
});

test("vyšší limit na poskytovatele přenosy zase pustí souběžně", async () => {
  assert.equal(await runThree(2), 2, "při dvojce mají běžet právě dva najednou");
});

test("the same source cannot be queued twice", async () => {
  const { directory, queue } = await tempQueue();
  try {
    const url = "http://127.0.0.1:1/film.mkv";
    const first = await queue.add("Film", { url });
    await queue.pause(first.id);
    await assert.rejects(() => queue.add("Film", { url }), /already in the queue/);
    await assert.rejects(() => queue.add("A different title", { url }), /already in the queue/, "the source decides, not the title");
    const other = await queue.add("Another film", { url: "http://127.0.0.1:1/other.mkv" });
    await queue.pause(other.id);
    assert.equal(queue.list().length, 2);
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clean close short of Content-Length is retried from the .part file", async () => {
  const size = 32 * 1024;
  const drop = 8 * 1024;
  let requests = 0;
  const { server, port } = await listen(async (req, res) => {
    requests += 1;
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
      await send(res, drop);
      res.end();
      return;
    }
    const offset = Number(range[1]);
    res.writeHead(206, { "content-length": String(size - offset), "content-range": `bytes ${offset}-${size - 1}/${size}` });
    await send(res, size - offset);
    res.end();
  });
  const { directory, queue, downloads } = await tempQueue({ stallTransferMs: 200, stallInitialMs: 200 });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error);
    assert.ok(requests >= 2, "the short first response must be followed by a Range resume");
    assert.equal((await stat(path.join(downloads, job.target))).size, size);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a clean close without a known size is not treated as finished", async () => {
  const { server, port } = await listen(async (_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4" });
    await send(res, 4096);
    res.end();
  });
  const { directory, queue } = await tempQueue();
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4`, behaviorHints: { videoSize: 40_000 } });
    await waitFor(queue, () => queue.list()[0].status === "failed" || queue.list()[0].retryCount === 3);
    const job = queue.list()[0];
    assert.notEqual(job.status, "completed");
    assert.match(job.error ?? "", /ended early|does not match|retry/);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ENOSPC pauses the queue and leaves later jobs untouched", async () => {
  let hits = 0;
  const { server, port } = await listen((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-length": "4096", "content-type": "video/mp4" });
    res.end(Buffer.alloc(4096));
  });
  const boom = () => new Writable({
    write(_chunk, _enc, cb) {
      cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }) as NodeJS.ErrnoException);
    },
  });
  const { directory, queue } = await tempQueue({
    createWriteStream: () => boom(),
    freeSpace: async () => ({ freeBytes: 0, totalBytes: 8 * GiB }),
  });
  try {
    await queue.add("Prvni", { url: `http://127.0.0.1:${port}/a.mp4` });
    await queue.add("Druhy", { url: `http://127.0.0.1:${port}/b.mp4` });
    await waitFor(queue, () => queue.haltInfo()?.reason === "storage");
    assert.equal(queue.list()[0].status, "paused");
    assert.equal(queue.list()[0].pauseReason, "storage");
    assert.equal(queue.list()[1].status, "queued");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(hits, 1, "the second job must not start while storage is halted");
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the queue resumes by itself once free space returns", async () => {
  const size = 4096;
  let failWrite = true;
  let freeBytes = 0;
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(size), "content-type": "video/mp4" });
    res.end(Buffer.alloc(size));
  });
  const { directory, queue, downloads } = await tempQueue({
    spaceCheckMs: 40,
    freeSpace: async () => ({ freeBytes, totalBytes: 8 * GiB }),
    createWriteStream: (file, options) => failWrite
      ? new Writable({ write(_c, _e, cb) { cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }) as NodeJS.ErrnoException); } })
      : createWriteStream(file, options),
  });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.haltInfo()?.reason === "storage");
    failWrite = false;
    freeBytes = 8 * GiB;
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    assert.equal(queue.list()[0].status, "completed", queue.list()[0].error);
    assert.equal(queue.haltInfo(), null);
    assert.equal((await stat(path.join(downloads, queue.list()[0].target))).size, size);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a 206 that restarts at byte 0 does not append onto the .part file", async () => {
  const size = 16 * 1024;
  const drop = 4 * 1024;
  const { server, port } = await listen(async (req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (!range) {
      res.writeHead(200, { "content-length": String(size) });
      res.end(Buffer.alloc(drop, 1));
      return;
    }
    res.writeHead(206, { "content-length": String(size), "content-range": `bytes 0-${size - 1}/${size}` });
    res.end(Buffer.alloc(size, 2));
  });
  const { directory, queue, downloads } = await tempQueue({ stallTransferMs: 200, stallInitialMs: 200 });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "completed" || queue.list()[0].status === "failed");
    const job = queue.list()[0];
    assert.equal(job.status, "completed", job.error);
    const body = await readFile(path.join(downloads, job.target));
    assert.equal(body.length, size);
    assert.ok(body.every((byte) => byte === 2), "the restarted payload must replace the partial, not follow it");
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("notBefore stops pump from retrying immediately", async () => {
  let hits = 0;
  const { server, port } = await listen((_req, res) => {
    hits += 1;
    res.writeHead(429, { "retry-after": "60" });
    res.end();
  });
  const { directory, queue } = await tempQueue({ retryDelay: (_count, after) => after ?? 60_000 });
  try {
    await queue.add("Film", { url: `http://127.0.0.1:${port}/film.mp4` });
    await waitFor(queue, () => (queue.list()[0].retryCount ?? 0) >= 1);
    const hitsAfterFirst = hits;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(hits, hitsAfterFirst, "Retry-After must be honoured");
    assert.equal(queue.list()[0].status, "queued");
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a downloading job is requeued from the .part file after load", async () => {
  const size = 8192;
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  const downloads = path.join(directory, "downloads");
  await mkdir(data, { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(downloads, "Film.mp4.part"), Buffer.alloc(2048, 9));
  const { server, port } = await listen((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    assert.ok(range, "the restored job must send Range");
    assert.equal(Number(range![1]), 2048);
    res.writeHead(206, { "content-length": String(size - 2048), "content-range": `bytes 2048-${size - 1}/${size}` });
    res.end(Buffer.alloc(size - 2048, 8));
  });
  await writeFile(path.join(data, "downloads.json"), JSON.stringify([{
    id: "job-1", title: "Film", status: "downloading", target: "Film.mp4", received: 2048, total: size,
    speed: 100, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    stream: { url: `http://127.0.0.1:${port}/film.mp4` },
  }]));
  const restored = new DownloadQueue(() => 1, () => 1, data, downloads, { retryDelay: () => 30 });
  try {
    await restored.load();
    await waitFor(restored, () => restored.list()[0].status === "completed" || restored.list()[0].status === "failed");
    assert.equal(restored.list()[0].status, "completed", restored.list()[0].error);
    assert.equal((await stat(path.join(downloads, "Film.mp4"))).size, size);
  } finally {
    restored.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP 404 fails a direct job and moves a lazy job to the next source", async () => {
  let goodHits = 0;
  const { server, port } = await listen((req, res) => {
    if (req.url === "/missing.mp4") { res.writeHead(404); res.end(); return; }
    goodHits += 1;
    res.writeHead(200, { "content-length": "2048" });
    res.end(Buffer.alloc(2048));
  });
  const { directory, queue } = await tempQueue();
  try {
    await queue.add("Primo", { url: `http://127.0.0.1:${port}/missing.mp4` });
    await waitFor(queue, () => queue.list()[0].status === "failed");
    assert.match(queue.list()[0].error ?? "", /HTTP 404/);

    queue.setResolver(async (_type, _id, tried) => {
      const url = tried.includes(`http://127.0.0.1:${port}/missing.mp4`)
        ? `http://127.0.0.1:${port}/ok.mp4`
        : `http://127.0.0.1:${port}/missing.mp4`;
      return { stream: { url }, settings: defaultDownloadSettings() };
    });
    await queue.addPending("Díl", { type: "series", videoId: "tt1" }, { kind: "episode", title: "Show", season: 1, episode: 1 });
    await waitFor(queue, () => queue.list().some((job) => job.title === "Díl" && (job.status === "completed" || job.status === "failed")));
    const lazy = queue.list().find((job) => job.title === "Díl")!;
    assert.equal(lazy.status, "completed", lazy.error);
    assert.ok(goodHits >= 1);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const HASH = "59e11cef8c2152ac73681092844ebd3db19025bc";

test("a torrent waits on Real-Debrid then downloads over HTTP without taking a slot", async () => {
  const payload = Buffer.alloc(32 * 1024, 7);
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-length": String(payload.length), "content-type": "video/mp4" });
    res.end(payload);
  });
  let calls = 0;
  let ready = false;
  const { directory, queue, downloads } = await tempQueue({
    debridPollMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => {
        calls += 1;
        if (!ready) return { ready: false, torrentId: "rd1", progress: 40, status: "downloading" };
        return { ready: true, torrentId: "rd1", url: `http://127.0.0.1:${port}/movie.mp4`, filename: "Movie.mkv" };
      },
    },
  });
  try {
    const waiting = await queue.add("Film", { infoHash: HASH, fileIdx: 0, name: "1080p" });
    assert.equal(waiting.status, "waiting");
    await queue.add("Http", { url: `http://127.0.0.1:${port}/other.mp4` });
    await waitFor(queue, () => queue.list().some((job) => job.title === "Http" && job.status === "completed"));
    assert.equal(queue.list().find((job) => job.title === "Film")?.status, "waiting");
    ready = true;
    await waitFor(queue, () => queue.list().every((job) => job.status === "completed"));
    const torrent = queue.list().find((job) => job.title === "Film")!;
    assert.equal(torrent.status, "completed");
    assert.equal(torrent.debridProgress, 100);
    assert.equal((await stat(path.join(downloads, torrent.target))).size, payload.length);
    assert.ok(calls >= 2);
  } finally {
    queue.stop();
    server.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("the same infoHash is not queued twice", async () => {
  const { directory, queue } = await tempQueue({
    debrid: { configured: () => true, advance: async () => ({ ready: false, torrentId: "rd1", progress: 1, status: "queued" }) },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await assert.rejects(queue.add("Film", { infoHash: HASH, fileIdx: 0 }), /already in the queue/);
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dropped Real-Debrid call is retried instead of failing the job", async () => {
  let calls = 0;
  const { directory, queue } = await tempQueue({
    debridPollMs: 20,
    debridRetryMs: 20,
    debrid: {
      configured: () => true,
      advance: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return { ready: false, torrentId: "rd1", progress: 10, status: "downloading" };
      },
    },
  });
  try {
    await queue.add("Film", { infoHash: HASH, fileIdx: 0 });
    await waitFor(queue, () => calls >= 2 && queue.list()[0].status === "waiting");
    assert.equal(queue.list()[0].status, "waiting");
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a torrent without a token is refused", async () => {
  const { directory, queue } = await tempQueue();
  try {
    await assert.rejects(queue.add("Film", { infoHash: HASH }), /Real-Debrid/);
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a damaged queue file is quarantined and the server still starts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-dl-"));
  const data = path.join(directory, "data");
  await mkdir(data, { recursive: true });
  const state = path.join(data, "downloads.json");
  await writeFile(state, "{not-json");
  const queue = new DownloadQueue(() => 1, () => 1, data, path.join(directory, "downloads"));
  try {
    await queue.load();
    assert.equal(queue.list().length, 0);
    assert.equal(await readFile(`${state}.bak`, "utf8"), "{not-json");
  } finally {
    queue.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
