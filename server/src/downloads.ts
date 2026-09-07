import { AppError } from "./errors.js";
import { createWriteStream as fsCreateWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddonDownloadSettings, StreamItem } from "./types.js";
import { defaultDownloadSettings, joinTarget, streamExtension, targetPath, type MediaInfo } from "./naming.js";
import type { DownloadTargetSettings } from "./types.js";
import { safeFetch } from "./security.js";
import { log } from "./logger.js";
import { retryAfterMs } from "./outbound.js";
import {
  classifyFailure, expectedSize, HttpSourceError, IncompleteDownloadError, parseContentRange,
  retryDelayMs, SourceError, StorageError, storageHeadroom, storageMessage, storageResumeNeed,
  type QueueHalt,
} from "./download-policy.js";
import { isRetryableDebridFailure, type DebridAdvance } from "./debrid.js";

export type { QueueHalt };
export type DownloadStatus = "queued" | "waiting" | "downloading" | "paused" | "completed" | "failed";
export type PauseReason = "user" | "storage";
/** Úloha bez `stream` je líná: zdroj pro ni vybere resolver až v okamžiku, kdy na ni
 *  ve frontě dojde řada. `tried` chrání před opakováním už selhaných adres. */
export interface DownloadJob {
  id: string; title: string; stream?: StreamItem; media?: MediaInfo;
  source?: { type: string; videoId: string; tried: string[] };
  status: DownloadStatus; target: string; received: number; total?: number; speed: number;
  error?: string;
  /** Catalogue key for `error`, so the interface can show it in the reader's language.
   *  A failure whose text is built from a source's own words carries none. */
  errorKey?: string;
  errorVars?: Record<string, string | number>;
  retryCount?: number; pauseReason?: PauseReason; notBefore?: number;
  debrid?: { torrentId?: string; progress?: number; status?: string };
  createdAt: string; updatedAt: string;
}
export type StreamResolver = (type: string, videoId: string, tried: string[]) => Promise<{ stream: StreamItem; settings: AddonDownloadSettings } | undefined>;
export interface DebridEngine {
  configured: () => boolean;
  advance: (input: { infoHash: string; fileIdx?: number; torrentId?: string }) => Promise<DebridAdvance>;
}
export interface QueueHooks {
  now?: () => number;
  freeSpace?: (dir: string) => Promise<{ freeBytes?: number; totalBytes?: number }>;
  createWriteStream?: (file: string, options: { flags: string }) => NodeJS.WritableStream;
  stallInitialMs?: number;
  stallTransferMs?: number;
  spaceCheckMs?: number;
  retryDelay?: (retryCount: number, retryAfterMs?: number) => number;
  debrid?: DebridEngine;
  debridPollMs?: number;
  debridRetryMs?: number;
  debridTimeoutMs?: number;
}

const exists = async (file: string) => { try { await stat(file); return true; } catch { return false; } };
const MiB = 1024 ** 2;

export async function volumeSpace(target: string) {
  try {
    const info = await statfs(target);
    return { freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
  } catch {
    return {};
  }
}

export class DownloadQueue {
  private jobs: DownloadJob[] = [];
  private active = new Map<string, AbortController>();
  private pauseRequested = new Set<string>();
  private pumpScheduled = false;
  private saveTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private spaceWatch?: NodeJS.Timeout;
  private saveChain: Promise<void> = Promise.resolve();
  private resolver?: StreamResolver;
  private halt?: QueueHalt;
  private readonly stateFile: string;
  private readonly downloadDir: string;
  private readonly now: () => number;
  private readonly freeSpace: (dir: string) => Promise<{ freeBytes?: number; totalBytes?: number }>;
  private readonly createWriteStream: (file: string, options: { flags: string }) => NodeJS.WritableStream;
  private readonly stallInitialMs: number;
  private readonly stallTransferMs: number;
  private readonly spaceCheckMs: number;
  private readonly retryDelay: (retryCount: number, retryAfterMs?: number) => number;
  private debrid?: DebridEngine;
  private readonly debridPollMs: number;
  private readonly debridRetryMs: number;
  private readonly debridTimeoutMs: number;
  private debridTimers = new Map<string, NodeJS.Timeout>();
  private debridBusy = new Set<string>();
  /** Zavolá se po úspěšném dokončení, aby knihovna mohla rovnou vyrobit náhled. */
  onCompleted?: (job: Readonly<DownloadJob>) => void | Promise<void>;
  /** Přenesené bajty, jak přitékají. Statistiky je tak zapíšou do chvíle, kdy
   * provoz opravdu tekl, a započítají i to, co se stáhlo před chybou nebo zrušením. */
  onProgress?: (job: Readonly<DownloadJob>, bytes: number) => void;

  constructor(
    private concurrency: () => number = () => 1,
    private perProvider: () => number = () => 1,
    dataDir = process.env.DATA_DIR ?? "/data",
    downloadDir = process.env.DOWNLOAD_DIR ?? "/downloads",
    hooks: QueueHooks = {},
  ) {
    this.stateFile = path.join(dataDir, "downloads.json");
    this.downloadDir = downloadDir;
    this.now = hooks.now ?? Date.now;
    this.freeSpace = hooks.freeSpace ?? volumeSpace;
    this.createWriteStream = hooks.createWriteStream ?? fsCreateWriteStream;
    this.stallInitialMs = hooks.stallInitialMs ?? 15_000;
    this.stallTransferMs = hooks.stallTransferMs ?? 30_000;
    this.spaceCheckMs = hooks.spaceCheckMs ?? 30_000;
    this.retryDelay = hooks.retryDelay ?? retryDelayMs;
    this.debrid = hooks.debrid;
    this.debridPollMs = hooks.debridPollMs ?? 15_000;
    this.debridRetryMs = hooks.debridRetryMs ?? 30_000;
    this.debridTimeoutMs = hooks.debridTimeoutMs ?? 72 * 60 * 60_000;
  }

  /** Výběr zdroje pro líné úlohy si drží index.ts, protože potřebuje doplňky a nastavení. */
  setResolver(resolver: StreamResolver) { this.resolver = resolver; }
  setDebrid(engine: DebridEngine) { this.debrid = engine; }
  haltInfo() { return this.halt ? { ...this.halt } : null; }
  stop() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.spaceWatch) clearInterval(this.spaceWatch);
    this.saveTimer = undefined; this.retryTimer = undefined; this.spaceWatch = undefined;
    for (const timer of this.debridTimers.values()) clearTimeout(timer);
    this.debridTimers.clear();
    for (const controller of this.active.values()) controller.abort();
  }

  async load() {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await mkdir(this.downloadDir, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Queue state is not a list.");
      this.jobs = parsed as DownloadJob[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log("ERROR", "The queue state was unreadable, starting empty", { reason: e instanceof Error ? e.message : String(e) });
        await rename(this.stateFile, `${this.stateFile}.bak`).catch(() => undefined);
        this.jobs = [];
      }
    }
    for (const job of this.jobs) {
      if (job.status === "downloading") job.status = "queued";
      job.updatedAt ??= job.createdAt;
      job.speed = 0;
      job.notBefore = undefined;
    }
    if (this.jobs.some((job) => job.status === "paused" && job.pauseReason === "storage")) {
      this.halt = { reason: "storage", at: new Date().toISOString(), message: "There is no space left on the disk.", messageKey: "err.noSpace" };
      this.ensureSpaceWatch();
    }
    await this.save();
    this.pump();
    for (const job of this.jobs) if (job.status === "waiting") this.scheduleDebrid(job.id);
  }

  list() { return this.jobs.map((job, index) => ({ ...this.publicJob(job), order: index })); }
  snapshot() { return { jobs: this.list(), halt: this.haltInfo() }; }

  async add(title: string, stream: StreamItem, media?: MediaInfo, targetSettings: DownloadTargetSettings = defaultDownloadSettings().movie) {
    if (!stream.url && stream.infoHash) return this.addDebrid(title, stream, media, targetSettings);
    if (!stream.url) throw new AppError("Only a direct HTTP stream can be downloaded.", "err.downloadNeedsHttp");
    // Bez téhle kontroly vznikne z dvojkliku na Stáhnout tentýž film dvakrát,
    // protože uniqueTarget té druhé úloze ochotně přidělí jméno s "(2)".
    const duplicate = this.jobs.find((job) => job.stream?.url === stream.url && job.status !== "failed");
    if (duplicate && duplicate.status !== "completed") throw new AppError("This source is already in the queue.", "err.sourceQueued");
    if (duplicate && await exists(path.join(this.downloadDir, duplicate.target))) throw new AppError("This source is already downloaded in the library.", "err.sourceDownloaded");
    const extension = streamExtension(stream);
    const { directory, base } = targetPath(media, title, extension, targetSettings);
    const target = await this.uniqueTarget(directory, base, extension);
    const now = new Date().toISOString();
    const job: DownloadJob = { id: crypto.randomUUID(), title, stream, media, status: "queued", target, received: 0, speed: 0, createdAt: now, updatedAt: now };
    this.jobs.push(job); await this.save(); this.pump(); return this.publicJob(job);
  }

  private sameTorrent(left: StreamItem | undefined, right: StreamItem) {
    return Boolean(left?.infoHash && left.infoHash === right.infoHash && (left.fileIdx ?? 0) === (right.fileIdx ?? 0));
  }

  private async addDebrid(title: string, stream: StreamItem, media: MediaInfo | undefined, targetSettings: DownloadTargetSettings) {
    if (!this.debrid?.configured()) throw new AppError("Set up Real-Debrid in Settings first.", "err.debridNotConfigured");
    const duplicate = this.jobs.find((job) => this.sameTorrent(job.stream, stream) && job.status !== "failed");
    if (duplicate && duplicate.status !== "completed") throw new AppError("This torrent is already in the queue.", "err.torrentQueued");
    const extension = streamExtension(stream);
    const { directory, base } = targetPath(media, title, extension, targetSettings);
    const target = await this.uniqueTarget(directory, base, extension);
    const now = new Date().toISOString();
    const job: DownloadJob = {
      id: crypto.randomUUID(), title, stream, media, status: "waiting", target, received: 0, speed: 0,
      debrid: {}, createdAt: now, updatedAt: now,
    };
    this.jobs.push(job); await this.save();
    log("INFO", "Waiting for Real-Debrid", { id: job.id, title: job.title, infoHash: stream.infoHash });
    this.scheduleDebrid(job.id);
    return this.publicJob(job);
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
    throw new AppError("No free file name could be found.", "err.noFreeName");
  }

  async pause(id: string) {
    const job = this.require(id);
    if (job.status === "completed") throw new AppError("A finished download cannot be paused.", "err.cannotPauseCompleted");
    this.clearDebrid(id);
    if (this.active.has(id)) this.pauseRequested.add(id);
    job.status = "paused";
    job.pauseReason = "user";
    job.speed = 0;
    job.updatedAt = new Date().toISOString();
    this.active.get(id)?.abort();
    log("INFO", "Download paused", { id, title: job.title, received: job.received });
    await this.save();
    for (let attempt = 0; attempt < 100 && this.active.has(id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async resume(id: string) {
    const job = this.require(id);
    if (!(["paused", "failed"] as DownloadStatus[]).includes(job.status)) throw new AppError("This item cannot be resumed.", "err.cannotResume");
    if (this.halt || job.pauseReason === "storage") {
      const space = await this.freeSpace(this.downloadDir);
      if (!this.hasRoom(space)) throw new AppError(this.halt?.message ?? "There is no space left on the disk.", this.halt?.messageKey ?? "err.noSpace");
      this.releaseStorageHalt();
    }
    this.pauseRequested.delete(id);
    if (job.status === "paused" || job.status === "failed") {
      const waiting = Boolean(job.stream?.infoHash && !job.stream.url);
      job.status = waiting ? "waiting" : "queued";
      this.setError(job);
      job.pauseReason = undefined;
      job.notBefore = undefined;
      job.updatedAt = new Date().toISOString();
      if (waiting) this.scheduleDebrid(job.id);
    }
    await this.save();
    this.pump();
  }

  async retry(id: string) {
    const job = this.require(id);
    if (job.status !== "failed") throw new AppError("Only a failed download can be retried.", "err.retryOnlyFailed");
    job.retryCount = 0;
    job.notBefore = undefined;
    if (job.source) {
      job.source.tried = [];
      if (!job.stream) { job.target = ""; job.received = 0; job.total = undefined; }
    }
    return this.resume(id);
  }

  private clearDebrid(id: string) {
    const timer = this.debridTimers.get(id);
    if (timer) clearTimeout(timer);
    this.debridTimers.delete(id);
  }

  private scheduleDebrid(id: string, delay = 0) {
    this.clearDebrid(id);
    const timer = setTimeout(() => { this.debridTimers.delete(id); void this.pollDebrid(id); }, delay);
    timer.unref?.();
    this.debridTimers.set(id, timer);
  }

  private async pollDebrid(id: string) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.status !== "waiting" || this.debridBusy.has(id)) return;
    this.debridBusy.add(id);
    try {
      if (this.now() - Date.parse(job.createdAt) > this.debridTimeoutMs) {
        job.status = "failed"; this.setError(job, "The Real-Debrid torrent did not finish in time.", "err.debridTimeout"); job.updatedAt = new Date().toISOString();
        await this.save();
        return;
      }
      if (!this.debrid?.configured()) {
        job.status = "failed"; this.setError(job, "The Real-Debrid token is missing.", "err.debridTokenMissing"); job.updatedAt = new Date().toISOString();
        await this.save();
        return;
      }
      const infoHash = job.stream?.infoHash;
      if (!infoHash) {
        job.status = "failed"; this.setError(job, "The job has no infoHash.", "err.jobNoInfoHash"); job.updatedAt = new Date().toISOString();
        await this.save();
        return;
      }
      const result = await this.debrid.advance({ infoHash, fileIdx: job.stream?.fileIdx, torrentId: job.debrid?.torrentId });
      job.debrid = { torrentId: result.torrentId, progress: result.ready ? 100 : result.progress, status: result.ready ? "downloaded" : result.status };
      job.updatedAt = new Date().toISOString();
      if (result.ready) {
        job.stream = {
          ...job.stream,
          url: result.url,
          behaviorHints: { ...job.stream?.behaviorHints, filename: result.filename ?? job.stream?.behaviorHints?.filename },
        };
        job.status = "queued";
        this.setError(job);
        log("INFO", "Real-Debrid finished, HTTP download will start", { id: job.id, title: job.title });
        await this.save();
        this.pump();
        return;
      }
      await this.saveSoon();
      this.scheduleDebrid(job.id, this.debridPollMs);
    } catch (error) {
      this.setError(job, error instanceof Error ? error.message : String(error));
      job.updatedAt = new Date().toISOString();
      if (isRetryableDebridFailure(error)) {
        log("WARN", "Real-Debrid is busy, will retry", { id: job.id, title: job.title, reason: job.error });
        await this.save();
        this.scheduleDebrid(job.id, Math.max(this.debridPollMs, this.debridRetryMs));
        return;
      }
      job.status = "failed";
      log("ERROR", "Real-Debrid job failed", { id: job.id, title: job.title, reason: job.error });
      await this.save();
    } finally {
      this.debridBusy.delete(id);
    }
  }

  async remove(id: string) {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new AppError("The item was not found.", "err.itemNotFound");
    const [job] = this.jobs.splice(index, 1);
    this.active.get(id)?.abort();
    if (job.status !== "completed" && job.target) await unlink(path.join(this.downloadDir, `${job.target}.part`)).catch(() => undefined);
    await this.save();
    this.pump();
  }

  async move(id: string, direction: -1 | 1) {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new AppError("The item was not found.", "err.itemNotFound");
    const next = Math.max(0, Math.min(this.jobs.length - 1, index + direction));
    if (next !== index) { const [job] = this.jobs.splice(index, 1); this.jobs.splice(next, 0, job); await this.save(); }
    this.pump();
  }

  /** Dokončené úlohy pro prvotní naplnění statistik z fronty. */
  history() {
    return this.jobs.filter((job) => job.status === "completed").map((job) => ({
      at: job.updatedAt, bytes: job.received, url: job.stream?.url, addonKey: job.stream?.addonKey,
      addonName: job.stream?.addonName, title: job.title, kind: job.media?.kind,
    }));
  }
  async clearCompleted() { this.jobs = this.jobs.filter((job) => job.status !== "completed"); await this.save(); }
  changed() { this.pump(); }
  /** The key travels with the text so the interface can render a stored failure in
   *  whatever language is set now, not the one that was set when it failed. */
  private setError(job: DownloadJob, message?: string, key?: string, vars?: Record<string, string | number>) {
    job.error = message; job.errorKey = key; job.errorVars = vars;
  }

  private require(id: string) { const job = this.jobs.find((item) => item.id === id); if (!job) throw new AppError("The item was not found.", "err.itemNotFound"); return job; }
  /** Adresy zdrojů (často s tokeny) nesmí do rozhraní; ven jde jen příznak líné úlohy. */
  private publicJob({ stream, source, notBefore: _notBefore, debrid, ...job }: DownloadJob) {
    return { ...job, pending: !stream && Boolean(source), debridProgress: debrid?.progress };
  }
  /** Uložení musí jít za sebou: souběžné zápisy sdílejí jeden .tmp a druhé přejmenování
   *  pak nemá co přesouvat. Selhání zápisu stavu navíc nesmí shodit celý server. */
  private save() {
    this.saveChain = this.saveChain.then(async () => {
      const tmp = `${this.stateFile}.tmp`;
      await writeFile(tmp, JSON.stringify(this.jobs, null, 2), { mode: 0o600 });
      await rename(tmp, this.stateFile);
    }).catch((error) => { log("ERROR", "The queue state could not be saved", { reason: error instanceof Error ? error.message : String(error) }); });
    return this.saveChain;
  }
  private saveSoon() { if (this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save(); }, 1500); }
  /** Poskytovatel podle adresy zdroje. Dokud zdroj vybraný není, sdílí všechny úlohy
   * jedno vědro -- hromadně přidaný seriál se tím sám seřadí za sebe místo náporu. */
  private provider(job: DownloadJob) { const url = job.stream?.url; if (!url) return "?"; try { return new URL(url).hostname; } catch { return "?"; } }

  private busy(provider: string, except?: string) {
    let count = 0;
    for (const job of this.jobs) if (this.active.has(job.id) && job.id !== except && this.provider(job) === provider) count += 1;
    return count;
  }

  private storageRemaining() {
    return this.jobs
      .filter((job) => job.status === "paused" && job.pauseReason === "storage")
      .reduce((sum, job) => sum + Math.max(0, (job.total ?? 0) - job.received), 0);
  }

  private hasRoom(space: { freeBytes?: number; totalBytes?: number }, remaining = this.storageRemaining()) {
    if (space.freeBytes == null) return true;
    return space.freeBytes >= storageResumeNeed(space.totalBytes, remaining);
  }

  private async admitStorage(needed: number) {
    const space = await this.freeSpace(this.downloadDir);
    if (space.freeBytes == null) return;
    if (space.freeBytes < needed + storageHeadroom(space.totalBytes)) {
      throw new StorageError("There is no space left on the disk.", "ENOSPC");
    }
  }

  private releaseStorageHalt() {
    this.halt = undefined;
    if (this.spaceWatch) { clearInterval(this.spaceWatch); this.spaceWatch = undefined; }
    for (const job of this.jobs) {
      if (job.status === "paused" && job.pauseReason === "storage") {
        job.status = "queued";
        job.pauseReason = undefined;
        this.setError(job);
        job.notBefore = undefined;
        job.updatedAt = new Date().toISOString();
      }
    }
  }

  private async haltForStorage(reason: { message: string; key: string }) {
    this.halt = { reason: "storage", at: new Date().toISOString(), message: reason.message, messageKey: reason.key };
    for (const job of this.jobs) {
      if (!this.active.has(job.id) && job.status !== "downloading") continue;
      this.pauseRequested.add(job.id);
      job.status = "paused";
      job.pauseReason = "storage";
      this.setError(job, reason.message, reason.key);
      job.speed = 0;
      this.active.get(job.id)?.abort();
    }
    this.ensureSpaceWatch();
    log("ERROR", "The download queue halted because storage is unavailable", { reason: reason.message });
  }

  private ensureSpaceWatch() {
    if (this.spaceWatch) return;
    this.spaceWatch = setInterval(() => { void this.checkSpace(); }, this.spaceCheckMs);
  }

  private async checkSpace() {
    if (!this.halt) { if (this.spaceWatch) { clearInterval(this.spaceWatch); this.spaceWatch = undefined; } return; }
    try {
      const space = await this.freeSpace(this.downloadDir);
      if (!this.hasRoom(space)) return;
      log("INFO", "Storage has space again, the queue will continue", { freeBytes: space.freeBytes });
      this.releaseStorageHalt();
      await this.save();
      this.pump();
    } catch (error) {
      log("WARN", "Free space could not be checked", { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private pump() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      if (this.halt) return;
      const limit = Math.max(1, Math.min(8, this.concurrency()));
      const perProvider = Math.max(1, Math.min(8, this.perProvider()));
      const taken = new Map<string, number>();
      const now = this.now();
      for (const job of this.jobs) if (this.active.has(job.id)) { const key = this.provider(job); taken.set(key, (taken.get(key) ?? 0) + 1); }
      while (this.active.size < limit) {
        const job = this.jobs.find((item) => item.status === "queued" && !this.active.has(item.id) && (item.notBefore ?? 0) <= now && (taken.get(this.provider(item)) ?? 0) < perProvider);
        if (!job) break;
        const key = this.provider(job); taken.set(key, (taken.get(key) ?? 0) + 1);
        void this.download(job);
      }
      const waiting = this.jobs.filter((item) => item.status === "queued" && !this.active.has(item.id) && (item.notBefore ?? 0) > now);
      if (waiting.length) {
        const nextAt = Math.min(...waiting.map((item) => item.notBefore!));
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, Math.max(0, nextAt - this.now()));
      }
    });
  }

  /** Doplňky se na streamy ptáme až tady, těsně před stahováním jedné konkrétní epizody.
   *  Hromadné přidání celé série tak nevyvolá lavinu dotazů najednou. */
  private async resolve(job: DownloadJob) {
    if (!job.source) throw new SourceError("The job has neither a source nor a rule for finding one.");
    if (!this.resolver) throw new SourceError("Source selection is unavailable.");
    const resolved = await this.resolver(job.source.type, job.source.videoId, job.source.tried);
    if (!resolved?.stream.url) {
      throw new SourceError(job.source.tried.length
        ? `Every available source failed (${job.source.tried.length}).`
        : "No directly downloadable source was found.");
    }
    job.stream = resolved.stream;
    const settings = job.media?.kind === "episode" ? resolved.settings.series : resolved.settings.movie;
    const extension = streamExtension(resolved.stream);
    const { directory, base } = targetPath(job.media, job.title, extension, settings);
    job.target = await this.uniqueTarget(directory, base, extension);
    await this.save();
    log("INFO", "Download source selected", { id: job.id, title: job.title, addon: resolved.stream.addonName, target: job.target, attempt: job.source.tried.length + 1 });
  }

  private async download(job: DownloadJob) {
    const controller = new AbortController(); this.active.set(job.id, controller); job.status = "downloading"; this.setError(job); job.pauseReason = undefined; job.updatedAt = new Date().toISOString(); log("INFO", "Download started", { id: job.id, title: job.title, target: job.target || "(to be chosen)", previousBytes: job.received }); await this.save();
    let retryScheduled = false;
    let inactivity: NodeJS.Timeout | undefined;
    let stalled = false;
    try {
      if (!job.stream) await this.resolve(job);
      // Poskytovatel se dozví až po výběru zdroje. Když je právě vytížený, úloha se vrátí
      // do fronty; příští pump ji už zařadí do správného vědra a nesáhne po ní dřív, než se uvolní.
      if (this.busy(this.provider(job), job.id) >= Math.max(1, Math.min(8, this.perProvider()))) {
        job.status = "queued";
        log("INFO", "The provider is busy, the job will wait", { id: job.id, title: job.title, provider: this.provider(job) });
        return;
      }
      const stream = job.stream!;
      if (!stream.url) throw new SourceError("Only a direct HTTP stream can be downloaded.");
      const partial = path.join(this.downloadDir, `${job.target}.part`); const target = path.join(this.downloadDir, job.target);
      await mkdir(path.dirname(target), { recursive: true });
      let offset = 0; try { offset = (await stat(partial)).size; } catch { /* new download */ }
      const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}) }; if (offset) headers.range = `bytes=${offset}-`;
      const headerTimer = setTimeout(() => controller.abort(), 30_000); let response: Response;
      try { response = await safeFetch(stream.url, { headers, signal: controller.signal }); } finally { clearTimeout(headerTimer); }
      if (!response.ok || !response.body) {
        const wait = retryAfterMs(response.headers.get("retry-after"), this.now());
        await response.body?.cancel().catch(() => undefined);
        throw new HttpSourceError(response.status, `Zdroj odpověděl HTTP ${response.status}.`, wait);
      }
      log("INFO", "Source connected", { id: job.id, httpStatus: response.status, contentLength: response.headers.get("content-length"), contentRange: response.headers.get("content-range") });
      const range = parseContentRange(response.headers.get("content-range"));
      let resumed = false;
      if (offset > 0 && response.status === 206) {
        if (range?.start === offset) resumed = true;
        else if (range?.start === 0 || !range) offset = 0;
        else throw new IncompleteDownloadError(offset, range.total);
      } else if (offset > 0) {
        offset = 0;
      }
      const hinted = Number(stream.behaviorHints?.videoSize) || undefined;
      job.total = expectedSize(range?.total, (Number(response.headers.get("content-length")) || 0) + offset || undefined, hinted);
      job.received = offset;
      if (job.total) await this.admitStorage(job.total - offset);
      // Three attempts should mean "it failed three times in a row", not "three times ever".
      // Jakmile se přenos po navázání pořádně rozjede, je předchozí výpadek vyřízený
      // a rozpočet se vrací; jinak by velký soubor umřel na pár škytnutí za hodinu.
      const recoveredAt = 50 * MiB; let recovered = false; let firstByte = false;
      let received = offset; let lastProgressAt = this.now(); let lastSpeedAt = lastProgressAt; let lastBytes = received; let lastLog = received;
      const stallPollMs = Math.min(5_000, Math.max(200, Math.min(this.stallInitialMs, this.stallTransferMs) / 2));
      inactivity = setInterval(() => {
        const limit = firstByte ? this.stallTransferMs : this.stallInitialMs;
        if (this.now() - lastProgressAt > limit) {
          stalled = true;
          log("WARN", "The transfer has not moved", { id: job.id, received, idleMs: this.now() - lastProgressAt });
          controller.abort();
        }
      }, stallPollMs);
      const monitor = new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, output) => {
        received += chunk.byteLength; job.received = received; firstByte = true; lastProgressAt = this.now();
        this.onProgress?.(job, chunk.byteLength);
        if (!recovered && received - offset >= recoveredAt) { recovered = true; job.retryCount = 0; }
        const now = this.now();
        if (now - lastSpeedAt > 800) {
          job.speed = (received - lastBytes) / ((now - lastSpeedAt) / 1000);
          lastSpeedAt = now; lastBytes = received; job.updatedAt = new Date().toISOString(); this.saveSoon();
        }
        if (received - lastLog >= 50 * MiB) {
          log("INFO", "Download progress", { id: job.id, received, total: job.total, speed: Math.round(job.speed) });
          lastLog = received;
        }
        output.enqueue(chunk);
      } });
      await pipeline(Readable.fromWeb(response.body.pipeThrough(monitor) as never), this.createWriteStream(partial, { flags: resumed ? "a" : "w" }), { signal: controller.signal });
      clearInterval(inactivity); inactivity = undefined;
      const expected = expectedSize(job.total, hinted);
      if (!expected || job.received !== expected) throw new IncompleteDownloadError(job.received, expected);
      const handle = await open(partial, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(partial, target);
      job.status = "completed"; job.speed = 0; job.retryCount = 0; this.setError(job);
      log("INFO", "Download finished", { id: job.id, received: job.received, target: job.target });
      try { await this.onCompleted?.(job); }
      catch (error) { log("WARN", "The library could not be refreshed after completion", { id: job.id, reason: error instanceof Error ? error.message : String(error) }); }
    } catch (error) {
      job.speed = 0;
      const message = stalled ? "The transfer carried no data." : (error instanceof Error ? error.message : String(error));
      const kind = this.pauseRequested.has(job.id) ? "pause" as const : classifyFailure(error, { stalled });
      if (kind === "pause") {
        job.status = "paused";
        job.pauseReason ??= "user";
      } else if (kind === "storage") {
        await this.haltForStorage(storageMessage(error));
      } else if (kind === "transient" && (job.retryCount ?? 0) < 3) {
        if (error instanceof HttpSourceError && error.httpStatus === 416 && job.target) {
          await unlink(path.join(this.downloadDir, `${job.target}.part`)).catch(() => undefined);
          job.received = 0; job.total = undefined;
        }
        job.retryCount = (job.retryCount ?? 0) + 1;
        const wait = this.retryDelay(job.retryCount, error instanceof HttpSourceError ? error.retryAfterMs : undefined);
        job.notBefore = this.now() + wait;
        job.status = "queued";
        this.setError(job, `Connection dropped, retrying (${job.retryCount}/3)\u2026`, "err.retryingAfterDrop", { attempt: job.retryCount, of: 3 });
        retryScheduled = true;
        log("WARN", "The transfer broke off, it will be retried", { id: job.id, reason: message, retry: job.retryCount, waitMs: wait });
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, wait);
      } else if (job.source && job.stream?.url) {
        // Líná úloha zkusí další zdroj v pořadí; adresa toho selhaného se už nikdy nepoužije.
        job.source.tried.push(job.stream.url);
        if (job.target) await unlink(path.join(this.downloadDir, `${job.target}.part`)).catch(() => undefined);
        job.stream = undefined; job.target = ""; job.received = 0; job.total = undefined; job.retryCount = 0; job.notBefore = undefined;
        job.status = "queued"; this.setError(job, `The source failed (${message}), trying the next one\u2026`, "err.sourceFailedTryingNext", { reason: message });
        retryScheduled = true; log("WARN", "The source failed, trying the next one", { id: job.id, title: job.title, reason: message, tried: job.source.tried.length });
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, 2000);
      } else {
        job.status = "failed"; this.setError(job, message);
        log("ERROR", "Download failed", { id: job.id, reason: message, received: job.received, total: job.total });
      }
    } finally {
      if (inactivity) clearInterval(inactivity);
      this.pauseRequested.delete(job.id);
      job.updatedAt = new Date().toISOString();
      this.active.delete(job.id);
      await this.save();
      if (!retryScheduled) this.pump();
    }
  }
}
