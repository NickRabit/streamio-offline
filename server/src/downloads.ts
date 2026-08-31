import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StreamItem } from "./types.js";
import { safeFetch } from "./security.js";

export interface DownloadJob {
  id: string; title: string; stream: StreamItem; status: "queued" | "downloading" | "completed" | "failed";
  target: string; received: number; total?: number; speed: number; error?: string; createdAt: string;
}

const safe = (value: string) => value.normalize("NFC").replace(/[\x00-\x1f/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || "video";

export class DownloadQueue {
  private jobs: DownloadJob[] = [];
  private running = false;
  private readonly stateFile: string;
  private readonly downloadDir: string;
  constructor(dataDir = process.env.DATA_DIR ?? "/data", downloadDir = process.env.DOWNLOAD_DIR ?? "/downloads") {
    this.stateFile = path.join(dataDir, "downloads.json"); this.downloadDir = downloadDir;
  }
  async load() {
    await mkdir(path.dirname(this.stateFile), { recursive: true }); await mkdir(this.downloadDir, { recursive: true });
    try { this.jobs = JSON.parse(await readFile(this.stateFile, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    for (const job of this.jobs) if (job.status === "downloading") job.status = "queued";
    void this.run();
  }
  list() { return this.jobs.map(({ stream: _stream, ...job }) => job); }
  async add(title: string, stream: StreamItem) {
    if (!stream.url) throw new Error("Stáhnout lze zatím pouze přímý HTTP stream.");
    const hinted = stream.behaviorHints?.filename;
    const extension = path.extname(hinted ?? new URL(stream.url).pathname) || ".mp4";
    const filename = `${safe(title)}${extension}`;
    const job: DownloadJob = { id: crypto.randomUUID(), title, stream, status: "queued", target: filename, received: 0, speed: 0, createdAt: new Date().toISOString() };
    this.jobs.push(job); await this.save(); void this.run(); return this.publicJob(job);
  }
  private publicJob({ stream: _stream, ...job }: DownloadJob) { return job; }
  private async save() { const tmp = `${this.stateFile}.tmp`; await writeFile(tmp, JSON.stringify(this.jobs, null, 2), { mode: 0o600 }); await rename(tmp, this.stateFile); }
  private async run() {
    if (this.running) return; this.running = true;
    try {
      while (true) {
        const job = this.jobs.find((item) => item.status === "queued"); if (!job) break;
        job.status = "downloading"; job.error = undefined; await this.save();
        try {
          const headers = job.stream.behaviorHints?.proxyHeaders?.request ?? {};
          const response = await safeFetch(job.stream.url!, { headers, signal: AbortSignal.timeout(30_000) });
          if (!response.ok || !response.body) throw new Error(`Zdroj odpověděl HTTP ${response.status}.`);
          job.total = Number(response.headers.get("content-length")) || undefined;
          const partial = path.join(this.downloadDir, `${job.target}.part`); const target = path.join(this.downloadDir, job.target);
          let received = 0; let lastAt = Date.now(); let lastBytes = 0;
          const monitor = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
            received += chunk.byteLength; job.received = received;
            const now = Date.now(); if (now - lastAt > 800) { job.speed = (received - lastBytes) / ((now - lastAt) / 1000); lastAt = now; lastBytes = received; }
            controller.enqueue(chunk);
          }});
          await pipeline(Readable.fromWeb(response.body.pipeThrough(monitor) as never), createWriteStream(partial));
          await rename(partial, target); job.status = "completed"; job.speed = 0;
        } catch (error) { job.status = "failed"; job.speed = 0; job.error = error instanceof Error ? error.message : String(error); }
        await this.save();
      }
    } finally { this.running = false; }
  }
}
