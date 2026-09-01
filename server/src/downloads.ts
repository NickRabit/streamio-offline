import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddonDownloadSettings, StreamItem } from "./types.js";
import { defaultDownloadSettings, joinTarget, targetPath, type MediaInfo } from "./naming.js";
import type { DownloadTargetSettings } from "./types.js";
import { safeFetch } from "./security.js";
import { log } from "./logger.js";

export type DownloadStatus = "queued" | "downloading" | "paused" | "completed" | "failed";
/** Úloha bez `stream` je líná: zdroj pro ni vybere resolver až v okamžiku, kdy na ni
 *  ve frontě dojde řada. `tried` chrání před opakováním už selhaných adres. */
export interface DownloadJob { id: string; title: string; stream?: StreamItem; media?: MediaInfo; source?: { type: string; videoId: string; tried: string[] }; status: DownloadStatus; target: string; received: number; total?: number; speed: number; error?: string; retryCount?: number; createdAt: string; updatedAt: string }
export type StreamResolver = (type: string, videoId: string, tried: string[]) => Promise<{ stream: StreamItem; settings: AddonDownloadSettings } | undefined>;
const exists = async (file: string) => { try { await stat(file); return true; } catch { return false; } };

export class DownloadQueue {
  private jobs: DownloadJob[] = []; private active = new Map<string, AbortController>(); private pauseRequested = new Set<string>(); private pumpScheduled = false; private saveTimer?: NodeJS.Timeout; private saveChain: Promise<void> = Promise.resolve();
  private resolver?: StreamResolver;
  private readonly stateFile: string; private readonly downloadDir: string;
  constructor(private concurrency: () => number = () => 1, dataDir = process.env.DATA_DIR ?? "/data", downloadDir = process.env.DOWNLOAD_DIR ?? "/downloads") { this.stateFile = path.join(dataDir, "downloads.json"); this.downloadDir = downloadDir; }
  /** Výběr zdroje pro líné úlohy si drží index.ts, protože potřebuje doplňky a nastavení. */
  setResolver(resolver: StreamResolver) { this.resolver = resolver; }
  async load() { await mkdir(path.dirname(this.stateFile), { recursive: true }); await mkdir(this.downloadDir, { recursive: true }); try { this.jobs = JSON.parse(await readFile(this.stateFile, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } for (const job of this.jobs) { if (job.status === "downloading") job.status = "queued"; job.updatedAt ??= job.createdAt; job.speed = 0; } await this.save(); this.pump(); }
  list() { return this.jobs.map((job, index) => ({ ...this.publicJob(job), order: index })); }
  async add(title: string, stream: StreamItem, media?: MediaInfo, targetSettings: DownloadTargetSettings = defaultDownloadSettings().movie) {
    if (!stream.url) throw new Error("Stáhnout lze pouze přímý HTTP stream.");
    const hinted = stream.behaviorHints?.filename;
    const extension = path.extname(hinted ?? new URL(stream.url).pathname) || ".mp4";
    const { directory, base } = targetPath(media, title, extension, targetSettings);
    const target = await this.uniqueTarget(directory, base, extension);
    const now = new Date().toISOString();
    const job: DownloadJob = { id: crypto.randomUUID(), title, stream, status: "queued", target, received: 0, speed: 0, createdAt: now, updatedAt: now };
    this.jobs.push(job); await this.save(); this.pump(); return this.publicJob(job);
  }

  /** Líná úloha: cíl i zdroj se doplní při zahájení stahování. Duplicitní epizoda se nepřidává. */
  async addPending(title: string, source: { type: string; videoId: string }, media?: MediaInfo) {
    if (this.jobs.some((job) => job.source?.videoId === source.videoId && job.status !== "completed" && job.status !== "failed")) return undefined;
    const now = new Date().toISOString();
    const job: DownloadJob = { id: crypto.randomUUID(), title, media, source: { ...source, tried: [] }, status: "queued", target: "", received: 0, speed: 0, createdAt: now, updatedAt: now };
    this.jobs.push(job); await this.save(); this.pump(); return this.publicJob(job);
  }

  /** Historii lze vyčistit, ale soubory zůstávají. Volné jméno se proto musí hledat i na disku,
   *  jinak by se hotový film tiše přepsal stahováním stejného titulu. */
  private async uniqueTarget(directory: string, base: string, extension: string) {
    for (let copy = 1; copy <= 999; copy += 1) {
      const relative = joinTarget(directory, base, extension, copy);
      if (this.jobs.some((job) => job.target === relative)) continue;
      const full = path.join(this.downloadDir, relative);
      if (await exists(full) || await exists(`${full}.part`)) continue;
      return relative;
    }
    throw new Error("Nepodařilo se najít volné jméno souboru.");
  }

  async pause(id: string) { const job = this.require(id); if (job.status === "completed") throw new Error("Dokončené stahování nelze pozastavit."); if (this.active.has(id)) this.pauseRequested.add(id); job.status = "paused"; job.speed = 0; job.updatedAt = new Date().toISOString(); this.active.get(id)?.abort(); log("INFO", "Stahování pozastaveno", { id, title: job.title, received: job.received }); await this.save(); for (let attempt = 0; attempt < 100 && this.active.has(id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25)); }
  async resume(id: string) { const job = this.require(id); if (!(["paused", "failed"] as DownloadStatus[]).includes(job.status)) throw new Error("Tuto položku nelze obnovit."); this.pauseRequested.delete(id); job.status = "queued"; job.error = undefined; job.updatedAt = new Date().toISOString(); await this.save(); this.pump(); }
  async retry(id: string) { const job = this.require(id); if (job.status !== "failed") throw new Error("Opakovat lze pouze chybné stahování."); job.retryCount = 0; if (job.source) { job.source.tried = []; if (!job.stream) { job.target = ""; job.received = 0; job.total = undefined; } } return this.resume(id); }
  async remove(id: string) { const index = this.jobs.findIndex((job) => job.id === id); if (index < 0) throw new Error("Položka nebyla nalezena."); const [job] = this.jobs.splice(index, 1); this.active.get(id)?.abort(); if (job.status !== "completed" && job.target) await unlink(path.join(this.downloadDir, `${job.target}.part`)).catch(() => undefined); await this.save(); this.pump(); }
  async move(id: string, direction: -1 | 1) { const index = this.jobs.findIndex((job) => job.id === id); if (index < 0) throw new Error("Položka nebyla nalezena."); const next = Math.max(0, Math.min(this.jobs.length - 1, index + direction)); if (next !== index) { const [job] = this.jobs.splice(index, 1); this.jobs.splice(next, 0, job); await this.save(); } this.pump(); }
  async clearCompleted() { this.jobs = this.jobs.filter((job) => job.status !== "completed"); await this.save(); }
  changed() { this.pump(); }
  private require(id: string) { const job = this.jobs.find((item) => item.id === id); if (!job) throw new Error("Položka nebyla nalezena."); return job; }
  /** Adresy zdrojů (často s tokeny) nesmí do rozhraní; ven jde jen příznak líné úlohy. */
  private publicJob({ stream, source, ...job }: DownloadJob) { return { ...job, pending: !stream && Boolean(source) }; }
  /** Uložení musí jít za sebou: souběžné zápisy sdílejí jeden .tmp a druhé přejmenování
   *  pak nemá co přesouvat. Selhání zápisu stavu navíc nesmí shodit celý server. */
  private save() {
    this.saveChain = this.saveChain.then(async () => {
      const tmp = `${this.stateFile}.tmp`;
      await writeFile(tmp, JSON.stringify(this.jobs, null, 2), { mode: 0o600 });
      await rename(tmp, this.stateFile);
    }).catch((error) => { log("ERROR", "Stav fronty se nepodařilo uložit", { reason: error instanceof Error ? error.message : String(error) }); });
    return this.saveChain;
  }
  private saveSoon() { if (this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save(); }, 1500); }
  private pump() { if (this.pumpScheduled) return; this.pumpScheduled = true; queueMicrotask(() => { this.pumpScheduled = false; const limit = Math.max(1, Math.min(8, this.concurrency())); while (this.active.size < limit) { const job = this.jobs.find((item) => item.status === "queued" && !this.active.has(item.id)); if (!job) break; void this.download(job); } }); }

  /** Doplňky se na streamy ptáme až tady, těsně před stahováním jedné konkrétní epizody.
   *  Hromadné přidání celé série tak nevyvolá lavinu dotazů najednou. */
  private async resolve(job: DownloadJob) {
    if (!job.source) throw new Error("Úloha nemá zdroj ani předpis, jak ho najít.");
    if (!this.resolver) throw new Error("Výběr zdroje není k dispozici.");
    const resolved = await this.resolver(job.source.type, job.source.videoId, job.source.tried);
    if (!resolved?.stream.url) {
      throw new Error(job.source.tried.length
        ? `Všechny dostupné zdroje selhaly (${job.source.tried.length}).`
        : "Nenašel se žádný přímo stažitelný zdroj.");
    }
    job.stream = resolved.stream;
    const settings = job.media?.kind === "episode" ? resolved.settings.series : resolved.settings.movie;
    const hinted = resolved.stream.behaviorHints?.filename;
    const extension = path.extname(hinted ?? new URL(resolved.stream.url!).pathname) || ".mp4";
    const { directory, base } = targetPath(job.media, job.title, extension, settings);
    job.target = await this.uniqueTarget(directory, base, extension);
    await this.save();
    log("INFO", "Zdroj pro stahování vybrán", { id: job.id, title: job.title, addon: resolved.stream.addonName, target: job.target, attempt: job.source.tried.length + 1 });
  }

  private async download(job: DownloadJob) {
    const controller = new AbortController(); this.active.set(job.id, controller); job.status = "downloading"; job.error = undefined; job.updatedAt = new Date().toISOString(); log("INFO", "Stahování zahájeno", { id: job.id, title: job.title, target: job.target || "(vybere se)", previousBytes: job.received }); await this.save();
    let retryScheduled = false;
    let inactivity: NodeJS.Timeout | undefined;
    let stalled = false;
    try {
      if (!job.stream) await this.resolve(job);
      const stream = job.stream!;
      if (!stream.url) throw new Error("Stáhnout lze pouze přímý HTTP stream.");
      const partial = path.join(this.downloadDir, `${job.target}.part`); const target = path.join(this.downloadDir, job.target);
      await mkdir(path.dirname(target), { recursive: true });
      let offset = 0; try { offset = (await stat(partial)).size; } catch { /* new download */ }
      const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}) }; if (offset) headers.range = `bytes=${offset}-`;
      const headerTimer = setTimeout(() => controller.abort(), 30_000); let response: Response;
      try { response = await safeFetch(stream.url, { headers, signal: controller.signal }); } finally { clearTimeout(headerTimer); }
      if (!response.ok || !response.body) throw new Error(`Zdroj odpověděl HTTP ${response.status}.`); log("INFO", "Zdroj připojen", { id: job.id, httpStatus: response.status, contentLength: response.headers.get("content-length"), contentRange: response.headers.get("content-range") });
      const resumed = offset > 0 && response.status === 206; if (!resumed) offset = 0;
      const contentRange = response.headers.get("content-range"); const rangeTotal = contentRange?.match(/\/(\d+)$/)?.[1]; job.total = Number(rangeTotal) || (Number(response.headers.get("content-length")) || 0) + offset || undefined; job.received = offset;
      let received = offset; let lastAt = Date.now(); let lastBytes = received; let lastLog = received; inactivity = setInterval(() => { if (Date.now() - lastAt > 90_000) { stalled = true; log("WARN", "Přenos se 90 s neposunul", { id: job.id, received }); controller.abort(); } }, 5_000);
      const monitor = new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, output) => { received += chunk.byteLength; job.received = received; const now = Date.now(); if (now - lastAt > 800) { job.speed = (received - lastBytes) / ((now - lastAt) / 1000); lastAt = now; lastBytes = received; job.updatedAt = new Date().toISOString(); this.saveSoon(); } if (received - lastLog >= 50 * 1024 * 1024) { log("INFO", "Průběh stahování", { id: job.id, received, total: job.total, speed: Math.round(job.speed) }); lastLog = received; } output.enqueue(chunk); } });
      await pipeline(Readable.fromWeb(response.body.pipeThrough(monitor) as never), createWriteStream(partial, { flags: resumed ? "a" : "w" }), { signal: controller.signal });
      clearInterval(inactivity); if (job.total && job.received !== job.total) throw new Error(`Stažená velikost nesouhlasí (${job.received} / ${job.total}).`); await rename(partial, target); job.status = "completed"; job.speed = 0; log("INFO", "Stahování dokončeno", { id: job.id, received: job.received, target: job.target });
    } catch (error) {
      job.speed = 0; const message = stalled ? "Přenos bez dat déle než 90 s." : (error instanceof Error ? error.message : String(error));
      if (this.pauseRequested.has(job.id)) job.status = "paused";
      else if (/terminated|aborted|ECONNRESET|socket|fetch failed|stalled|bez dat/i.test(message) && (job.retryCount ?? 0) < 3) { job.retryCount = (job.retryCount ?? 0) + 1; job.status = "queued"; job.error = `Přerušené spojení, opakuji (${job.retryCount}/3)…`; retryScheduled = true; log("WARN", "Přenos přerušen, bude opakován", { id: job.id, reason: message, retry: job.retryCount }); setTimeout(() => this.pump(), 1500 * job.retryCount); }
      else if (job.source && job.stream?.url) {
        // Líná úloha zkusí další zdroj v pořadí; adresa toho selhaného se už nikdy nepoužije.
        job.source.tried.push(job.stream.url);
        if (job.target) await unlink(path.join(this.downloadDir, `${job.target}.part`)).catch(() => undefined);
        job.stream = undefined; job.target = ""; job.received = 0; job.total = undefined; job.retryCount = 0;
        job.status = "queued"; job.error = `Zdroj selhal (${message}), zkusím další…`;
        retryScheduled = true; log("WARN", "Zdroj selhal, zkusím další v pořadí", { id: job.id, title: job.title, reason: message, tried: job.source.tried.length });
        setTimeout(() => this.pump(), 2000);
      }
      else { job.status = "failed"; job.error = message; log("ERROR", "Stahování selhalo", { id: job.id, reason: message, received: job.received, total: job.total }); }
    }
    finally { if (inactivity) clearInterval(inactivity); this.pauseRequested.delete(job.id); job.updatedAt = new Date().toISOString(); this.active.delete(job.id); await this.save(); if (!retryScheduled) this.pump(); }
  }
}
