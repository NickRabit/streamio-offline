import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddonDownloadSettings, StreamItem } from "./types.js";
import { defaultDownloadSettings, joinTarget, streamExtension, targetPath, type MediaInfo } from "./naming.js";
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
  /** Zavolá se po úspěšném dokončení, aby knihovna mohla rovnou vyrobit náhled. */
  onCompleted?: (job: Readonly<DownloadJob>) => void | Promise<void>;
  /** Přenesené bajty, jak přitékají. Statistiky je tak zapíšou do chvíle, kdy
   * provoz opravdu tekl, a započítají i to, co se stáhlo před chybou nebo zrušením. */
  onProgress?: (job: Readonly<DownloadJob>, bytes: number) => void;
  constructor(private concurrency: () => number = () => 1, private perProvider: () => number = () => 1, dataDir = process.env.DATA_DIR ?? "/data", downloadDir = process.env.DOWNLOAD_DIR ?? "/downloads") { this.stateFile = path.join(dataDir, "downloads.json"); this.downloadDir = downloadDir; }
  /** Výběr zdroje pro líné úlohy si drží index.ts, protože potřebuje doplňky a nastavení. */
  setResolver(resolver: StreamResolver) { this.resolver = resolver; }
  async load() { await mkdir(path.dirname(this.stateFile), { recursive: true }); await mkdir(this.downloadDir, { recursive: true }); try { this.jobs = JSON.parse(await readFile(this.stateFile, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } for (const job of this.jobs) { if (job.status === "downloading") job.status = "queued"; job.updatedAt ??= job.createdAt; job.speed = 0; } await this.save(); this.pump(); }
  list() { return this.jobs.map((job, index) => ({ ...this.publicJob(job), order: index })); }
  async add(title: string, stream: StreamItem, media?: MediaInfo, targetSettings: DownloadTargetSettings = defaultDownloadSettings().movie) {
    if (!stream.url) throw new Error("Stáhnout lze pouze přímý HTTP stream.");
    // Bez téhle kontroly vznikne z dvojkliku na Stáhnout tentýž film dvakrát,
    // protože uniqueTarget té druhé úloze ochotně přidělí jméno s "(2)".
    const duplicate = this.jobs.find((job) => job.stream?.url === stream.url && job.status !== "failed");
    if (duplicate && duplicate.status !== "completed") throw new Error("Tenhle zdroj už ve frontě je.");
    if (duplicate && await exists(path.join(this.downloadDir, duplicate.target))) throw new Error("Tenhle zdroj už je stažený v knihovně.");
    const extension = streamExtension(stream);
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

  async pause(id: string) { const job = this.require(id); if (job.status === "completed") throw new Error("Dokončené stahování nelze pozastavit."); if (this.active.has(id)) this.pauseRequested.add(id); job.status = "paused"; job.speed = 0; job.updatedAt = new Date().toISOString(); this.active.get(id)?.abort(); log("INFO", "Download paused", { id, title: job.title, received: job.received }); await this.save(); for (let attempt = 0; attempt < 100 && this.active.has(id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25)); }
  async resume(id: string) { const job = this.require(id); if (!(["paused", "failed"] as DownloadStatus[]).includes(job.status)) throw new Error("Tuto položku nelze obnovit."); this.pauseRequested.delete(id); job.status = "queued"; job.error = undefined; job.updatedAt = new Date().toISOString(); await this.save(); this.pump(); }
  async retry(id: string) { const job = this.require(id); if (job.status !== "failed") throw new Error("Opakovat lze pouze chybné stahování."); job.retryCount = 0; if (job.source) { job.source.tried = []; if (!job.stream) { job.target = ""; job.received = 0; job.total = undefined; } } return this.resume(id); }
  async remove(id: string) { const index = this.jobs.findIndex((job) => job.id === id); if (index < 0) throw new Error("Položka nebyla nalezena."); const [job] = this.jobs.splice(index, 1); this.active.get(id)?.abort(); if (job.status !== "completed" && job.target) await unlink(path.join(this.downloadDir, `${job.target}.part`)).catch(() => undefined); await this.save(); this.pump(); }
  async move(id: string, direction: -1 | 1) { const index = this.jobs.findIndex((job) => job.id === id); if (index < 0) throw new Error("Položka nebyla nalezena."); const next = Math.max(0, Math.min(this.jobs.length - 1, index + direction)); if (next !== index) { const [job] = this.jobs.splice(index, 1); this.jobs.splice(next, 0, job); await this.save(); } this.pump(); }
  /** Dokončené úlohy pro prvotní naplnění statistik z fronty. */
  history() { return this.jobs.filter((job) => job.status === "completed").map((job) => ({ at: job.updatedAt, bytes: job.received, url: job.stream?.url, addonKey: job.stream?.addonKey, addonName: job.stream?.addonName, title: job.title, kind: job.media?.kind })); }
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

  private pump() {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      const limit = Math.max(1, Math.min(8, this.concurrency()));
      const perProvider = Math.max(1, Math.min(8, this.perProvider()));
      const taken = new Map<string, number>();
      for (const job of this.jobs) if (this.active.has(job.id)) { const key = this.provider(job); taken.set(key, (taken.get(key) ?? 0) + 1); }
      while (this.active.size < limit) {
        const job = this.jobs.find((item) => item.status === "queued" && !this.active.has(item.id) && (taken.get(this.provider(item)) ?? 0) < perProvider);
        if (!job) break;
        const key = this.provider(job); taken.set(key, (taken.get(key) ?? 0) + 1);
        void this.download(job);
      }
    });
  }

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
    const extension = streamExtension(resolved.stream);
    const { directory, base } = targetPath(job.media, job.title, extension, settings);
    job.target = await this.uniqueTarget(directory, base, extension);
    await this.save();
    log("INFO", "Download source selected", { id: job.id, title: job.title, addon: resolved.stream.addonName, target: job.target, attempt: job.source.tried.length + 1 });
  }

  private async download(job: DownloadJob) {
    const controller = new AbortController(); this.active.set(job.id, controller); job.status = "downloading"; job.error = undefined; job.updatedAt = new Date().toISOString(); log("INFO", "Download started", { id: job.id, title: job.title, target: job.target || "(vybere se)", previousBytes: job.received }); await this.save();
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
      if (!stream.url) throw new Error("Stáhnout lze pouze přímý HTTP stream.");
      const partial = path.join(this.downloadDir, `${job.target}.part`); const target = path.join(this.downloadDir, job.target);
      await mkdir(path.dirname(target), { recursive: true });
      let offset = 0; try { offset = (await stat(partial)).size; } catch { /* new download */ }
      const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}) }; if (offset) headers.range = `bytes=${offset}-`;
      const headerTimer = setTimeout(() => controller.abort(), 30_000); let response: Response;
      try { response = await safeFetch(stream.url, { headers, signal: controller.signal }); } finally { clearTimeout(headerTimer); }
      if (!response.ok || !response.body) throw new Error(`Zdroj odpověděl HTTP ${response.status}.`); log("INFO", "Source connected", { id: job.id, httpStatus: response.status, contentLength: response.headers.get("content-length"), contentRange: response.headers.get("content-range") });
      const resumed = offset > 0 && response.status === 206; if (!resumed) offset = 0;
      const contentRange = response.headers.get("content-range"); const rangeTotal = contentRange?.match(/\/(\d+)$/)?.[1]; job.total = Number(rangeTotal) || (Number(response.headers.get("content-length")) || 0) + offset || undefined; job.received = offset;
      // Tři pokusy mají znamenat "třikrát po sobě to nešlo", ne "třikrát za celou dobu".
      // Jakmile se přenos po navázání pořádně rozjede, je předchozí výpadek vyřízený
      // a rozpočet se vrací; jinak by velký soubor umřel na pár škytnutí za hodinu.
      const recoveredAt = 50 * 1024 * 1024; let recovered = false;
      let received = offset; let lastAt = Date.now(); let lastBytes = received; let lastLog = received; inactivity = setInterval(() => { if (Date.now() - lastAt > 90_000) { stalled = true; log("WARN", "The transfer has not moved for 90 s", { id: job.id, received }); controller.abort(); } }, 5_000);
      const monitor = new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, output) => { received += chunk.byteLength; job.received = received; this.onProgress?.(job, chunk.byteLength); if (!recovered && received - offset >= recoveredAt) { recovered = true; job.retryCount = 0; } const now = Date.now(); if (now - lastAt > 800) { job.speed = (received - lastBytes) / ((now - lastAt) / 1000); lastAt = now; lastBytes = received; job.updatedAt = new Date().toISOString(); this.saveSoon(); } if (received - lastLog >= 50 * 1024 * 1024) { log("INFO", "Download progress", { id: job.id, received, total: job.total, speed: Math.round(job.speed) }); lastLog = received; } output.enqueue(chunk); } });
      await pipeline(Readable.fromWeb(response.body.pipeThrough(monitor) as never), createWriteStream(partial, { flags: resumed ? "a" : "w" }), { signal: controller.signal });
      clearInterval(inactivity); if (job.total && job.received !== job.total) throw new Error(`Stažená velikost nesouhlasí (${job.received} / ${job.total}).`); await rename(partial, target); job.status = "completed"; job.speed = 0; log("INFO", "Download finished", { id: job.id, received: job.received, target: job.target });
      try { await this.onCompleted?.(job); }
      catch (error) { log("WARN", "The library could not be refreshed after completion", { id: job.id, reason: error instanceof Error ? error.message : String(error) }); }
    } catch (error) {
      job.speed = 0; const message = stalled ? "Přenos bez dat déle než 90 s." : (error instanceof Error ? error.message : String(error));
      if (this.pauseRequested.has(job.id)) job.status = "paused";
      else if (/terminated|aborted|ECONNRESET|socket|fetch failed|stalled|bez dat/i.test(message) && (job.retryCount ?? 0) < 3) { job.retryCount = (job.retryCount ?? 0) + 1; job.status = "queued"; job.error = `Přerušené spojení, opakuji (${job.retryCount}/3)…`; retryScheduled = true; log("WARN", "The transfer broke off, it will be retried", { id: job.id, reason: message, retry: job.retryCount }); setTimeout(() => this.pump(), 1500 * job.retryCount); }
      else if (job.source && job.stream?.url) {
        // Líná úloha zkusí další zdroj v pořadí; adresa toho selhaného se už nikdy nepoužije.
        job.source.tried.push(job.stream.url);
        if (job.target) await unlink(path.join(this.downloadDir, `${job.target}.part`)).catch(() => undefined);
        job.stream = undefined; job.target = ""; job.received = 0; job.total = undefined; job.retryCount = 0;
        job.status = "queued"; job.error = `Zdroj selhal (${message}), zkusím další…`;
        retryScheduled = true; log("WARN", "The source failed, trying the next one", { id: job.id, title: job.title, reason: message, tried: job.source.tried.length });
        setTimeout(() => this.pump(), 2000);
      }
      else { job.status = "failed"; job.error = message; log("ERROR", "Download failed", { id: job.id, reason: message, received: job.received, total: job.total }); }
    }
    finally { if (inactivity) clearInterval(inactivity); this.pauseRequested.delete(job.id); job.updatedAt = new Date().toISOString(); this.active.delete(job.id); await this.save(); if (!retryScheduled) this.pump(); }
  }
}
