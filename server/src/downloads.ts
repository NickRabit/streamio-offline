import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StreamItem } from "./types.js";
import { safeFetch } from "./security.js";
import { log } from "./logger.js";

export type DownloadStatus = "queued" | "downloading" | "paused" | "completed" | "failed";
export interface DownloadJob { id: string; title: string; stream: StreamItem; status: DownloadStatus; target: string; received: number; total?: number; speed: number; error?: string; retryCount?: number; createdAt: string; updatedAt: string }
const safe = (value: string) => value.normalize("NFC").replace(/[\x00-\x1f/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || "video";

export class DownloadQueue {
  private jobs: DownloadJob[] = []; private active = new Map<string, AbortController>(); private pauseRequested = new Set<string>(); private pumpScheduled = false; private saveTimer?: NodeJS.Timeout;
  private readonly stateFile: string; private readonly downloadDir: string;
  constructor(private concurrency: () => number = () => 1, dataDir = process.env.DATA_DIR ?? "/data", downloadDir = process.env.DOWNLOAD_DIR ?? "/downloads") { this.stateFile = path.join(dataDir, "downloads.json"); this.downloadDir = downloadDir; }
  async load() { await mkdir(path.dirname(this.stateFile), { recursive: true }); await mkdir(this.downloadDir, { recursive: true }); try { this.jobs = JSON.parse(await readFile(this.stateFile, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } for (const job of this.jobs) { if (job.status === "downloading") job.status = "queued"; job.updatedAt ??= job.createdAt; job.speed = 0; } await this.save(); this.pump(); }
  list() { return this.jobs.map((job, index) => ({ ...this.publicJob(job), order: index })); }
  async add(title: string, stream: StreamItem) { if (!stream.url) throw new Error("Stáhnout lze pouze přímý HTTP stream."); const hinted = stream.behaviorHints?.filename; const extension = path.extname(hinted ?? new URL(stream.url).pathname) || ".mp4"; const base = safe(title); const duplicates = this.jobs.filter((job) => job.target === `${base}${extension}` || job.target.startsWith(`${base} (`)).length; const target = `${base}${duplicates ? ` (${duplicates + 1})` : ""}${extension}`; const now = new Date().toISOString(); const job: DownloadJob = { id: crypto.randomUUID(), title, stream, status: "queued", target, received: 0, speed: 0, createdAt: now, updatedAt: now }; this.jobs.push(job); await this.save(); this.pump(); return this.publicJob(job); }
  async pause(id: string) { const job = this.require(id); if (job.status === "completed") throw new Error("Dokončené stahování nelze pozastavit."); if (this.active.has(id)) this.pauseRequested.add(id); job.status = "paused"; job.speed = 0; job.updatedAt = new Date().toISOString(); this.active.get(id)?.abort(); log("INFO", "Stahování pozastaveno", { id, title: job.title, received: job.received }); await this.save(); for (let attempt = 0; attempt < 100 && this.active.has(id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25)); }
  async resume(id: string) { const job = this.require(id); if (!(["paused", "failed"] as DownloadStatus[]).includes(job.status)) throw new Error("Tuto položku nelze obnovit."); this.pauseRequested.delete(id); job.status = "queued"; job.error = undefined; job.updatedAt = new Date().toISOString(); await this.save(); this.pump(); }
  async retry(id: string) { const job = this.require(id); if (job.status !== "failed") throw new Error("Opakovat lze pouze chybné stahování."); job.retryCount = 0; return this.resume(id); }
  async remove(id: string) { const index = this.jobs.findIndex((job) => job.id === id); if (index < 0) throw new Error("Položka nebyla nalezena."); const [job] = this.jobs.splice(index, 1); this.active.get(id)?.abort(); if (job.status !== "completed") await unlink(path.join(this.downloadDir, `${job.target}.part`)).catch(() => undefined); await this.save(); this.pump(); }
  async move(id: string, direction: -1 | 1) { const index = this.jobs.findIndex((job) => job.id === id); if (index < 0) throw new Error("Položka nebyla nalezena."); const next = Math.max(0, Math.min(this.jobs.length - 1, index + direction)); if (next !== index) { const [job] = this.jobs.splice(index, 1); this.jobs.splice(next, 0, job); await this.save(); } this.pump(); }
  async clearCompleted() { this.jobs = this.jobs.filter((job) => job.status !== "completed"); await this.save(); }
  changed() { this.pump(); }
  private require(id: string) { const job = this.jobs.find((item) => item.id === id); if (!job) throw new Error("Položka nebyla nalezena."); return job; }
  private publicJob({ stream: _stream, ...job }: DownloadJob) { return job; }
  private async save() { const tmp = `${this.stateFile}.tmp`; await writeFile(tmp, JSON.stringify(this.jobs, null, 2), { mode: 0o600 }); await rename(tmp, this.stateFile); }
  private saveSoon() { if (this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save(); }, 1500); }
  private pump() { if (this.pumpScheduled) return; this.pumpScheduled = true; queueMicrotask(() => { this.pumpScheduled = false; const limit = Math.max(1, Math.min(8, this.concurrency())); while (this.active.size < limit) { const job = this.jobs.find((item) => item.status === "queued" && !this.active.has(item.id)); if (!job) break; void this.download(job); } }); }
  private async download(job: DownloadJob) {
    const controller = new AbortController(); this.active.set(job.id, controller); job.status = "downloading"; job.error = undefined; job.updatedAt = new Date().toISOString(); log("INFO", "Stahování zahájeno", { id: job.id, title: job.title, target: job.target, previousBytes: job.received }); await this.save();
    const partial = path.join(this.downloadDir, `${job.target}.part`); const target = path.join(this.downloadDir, job.target);
    let retryScheduled = false;
    let inactivity: NodeJS.Timeout | undefined;
    let stalled = false;
    try {
      let offset = 0; try { offset = (await stat(partial)).size; } catch { /* new download */ }
      const headers: Record<string, string> = { ...(job.stream.behaviorHints?.proxyHeaders?.request ?? {}) }; if (offset) headers.range = `bytes=${offset}-`;
      const headerTimer = setTimeout(() => controller.abort(), 30_000); let response: Response;
      try { response = await safeFetch(job.stream.url!, { headers, signal: controller.signal }); } finally { clearTimeout(headerTimer); }
      if (!response.ok || !response.body) throw new Error(`Zdroj odpověděl HTTP ${response.status}.`); log("INFO", "Zdroj připojen", { id: job.id, httpStatus: response.status, contentLength: response.headers.get("content-length"), contentRange: response.headers.get("content-range") });
      const resumed = offset > 0 && response.status === 206; if (!resumed) offset = 0;
      const contentRange = response.headers.get("content-range"); const rangeTotal = contentRange?.match(/\/(\d+)$/)?.[1]; job.total = Number(rangeTotal) || (Number(response.headers.get("content-length")) || 0) + offset || undefined; job.received = offset;
      let received = offset; let lastAt = Date.now(); let lastBytes = received; let lastLog = received; inactivity = setInterval(() => { if (Date.now() - lastAt > 90_000) { stalled = true; log("WARN", "Přenos se 90 s neposunul", { id: job.id, received }); controller.abort(); } }, 5_000);
      const monitor = new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, output) => { received += chunk.byteLength; job.received = received; const now = Date.now(); if (now - lastAt > 800) { job.speed = (received - lastBytes) / ((now - lastAt) / 1000); lastAt = now; lastBytes = received; job.updatedAt = new Date().toISOString(); this.saveSoon(); } if (received - lastLog >= 50 * 1024 * 1024) { log("INFO", "Průběh stahování", { id: job.id, received, total: job.total, speed: Math.round(job.speed) }); lastLog = received; } output.enqueue(chunk); } });
      await pipeline(Readable.fromWeb(response.body.pipeThrough(monitor) as never), createWriteStream(partial, { flags: resumed ? "a" : "w" }), { signal: controller.signal });
      clearInterval(inactivity); if (job.total && job.received !== job.total) throw new Error(`Stažená velikost nesouhlasí (${job.received} / ${job.total}).`); await rename(partial, target); job.status = "completed"; job.speed = 0; log("INFO", "Stahování dokončeno", { id: job.id, received: job.received, target: job.target });
    } catch (error) { job.speed = 0; const message = stalled ? "Přenos bez dat déle než 90 s." : (error instanceof Error ? error.message : String(error)); if (this.pauseRequested.has(job.id)) job.status = "paused"; else if (/terminated|aborted|ECONNRESET|socket|fetch failed|stalled|bez dat/i.test(message) && (job.retryCount ?? 0) < 3) { job.retryCount = (job.retryCount ?? 0) + 1; job.status = "queued"; job.error = `Přerušené spojení, opakuji (${job.retryCount}/3)…`; retryScheduled = true; log("WARN", "Přenos přerušen, bude opakován", { id: job.id, reason: message, retry: job.retryCount }); setTimeout(() => this.pump(), 1500 * job.retryCount); } else { job.status = "failed"; job.error = message; log("ERROR", "Stahování selhalo", { id: job.id, reason: message, received: job.received, total: job.total }); } }
    finally { if (inactivity) clearInterval(inactivity); this.pauseRequested.delete(job.id); job.updatedAt = new Date().toISOString(); this.active.delete(job.id); await this.save(); if (!retryScheduled) this.pump(); }
  }
}
