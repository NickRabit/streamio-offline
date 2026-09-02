import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DownloadEvent {
  at: string;
  bytes: number;
  provider: string;
  addonKey?: string;
  addonName?: string;
  title: string;
  kind: "movie" | "episode" | "other";
}

export interface Bucket { key: string; label: string; bytes: number; count: number }
export interface Window { bytes: number; count: number }
export interface Summary {
  day: Window; week: Window; month: Window; total: Window;
  days: Array<{ date: string; bytes: number; count: number }>;
  providers: Bucket[];
  addons: Bucket[];
  since?: string;
}

/** Den se počítá v místním čase serveru, ne v UTC -- jinak by se večerní
 * stahování v Praze objevilo v grafu jako včerejší. */
export const localDay = (value: Date) => value.toLocaleDateString("sv-SE");

const window = (events: DownloadEvent[], from: number): Window => {
  let bytes = 0; let count = 0;
  for (const event of events) if (Date.parse(event.at) >= from) { bytes += event.bytes; count += 1; }
  return { bytes, count };
};

const group = (events: DownloadEvent[], from: number, key: (event: DownloadEvent) => { key: string; label: string }) => {
  const buckets = new Map<string, Bucket>();
  for (const event of events) {
    if (Date.parse(event.at) < from) continue;
    const { key: id, label } = key(event);
    const bucket = buckets.get(id) ?? { key: id, label, bytes: 0, count: 0 };
    bucket.bytes += event.bytes; bucket.count += 1;
    buckets.set(id, bucket);
  }
  return [...buckets.values()].sort((a, b) => b.bytes - a.bytes);
};

/** Souhrn za zvolené období. Dny vrací i prázdné, aby graf nebyl děravý. */
export function summarize(events: DownloadEvent[], days: number, now = new Date()): Summary {
  const span = Math.max(1, Math.min(365, Math.trunc(days)));
  const dayMs = 24 * 60 * 60 * 1000;
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (span - 1));
  const from = start.getTime();

  const perDay = new Map<string, { bytes: number; count: number }>();
  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at) || at < from) continue;
    const key = localDay(new Date(at));
    const day = perDay.get(key) ?? { bytes: 0, count: 0 };
    day.bytes += event.bytes; day.count += 1;
    perDay.set(key, day);
  }
  const series = Array.from({ length: span }, (_, index) => {
    const date = localDay(new Date(from + index * dayMs));
    return { date, ...(perDay.get(date) ?? { bytes: 0, count: 0 }) };
  });

  return {
    day: window(events, now.getTime() - dayMs),
    week: window(events, now.getTime() - 7 * dayMs),
    month: window(events, now.getTime() - 30 * dayMs),
    total: window(events, 0),
    days: series,
    providers: group(events, from, (event) => ({ key: event.provider, label: event.provider })),
    addons: group(events, from, (event) => ({ key: event.addonKey ?? event.provider, label: event.addonName ?? event.provider })),
    since: events.reduce<string | undefined>((oldest, event) => (!oldest || event.at < oldest ? event.at : oldest), undefined),
  };
}

/** Nejstarší záznamy se zahazují, aby soubor nerostl donekonečna. */
const LIMIT = 20_000;

export class StatsLog {
  private events: DownloadEvent[] = [];
  private file: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir = process.env.DATA_DIR ?? "/data") { this.file = path.join(dataDir, "stats.json"); }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try { this.events = JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return this.events.length;
  }

  /** Doplní historii z fronty; hlídá se podle času a názvu, ať se nezdvojí. */
  async seed(events: DownloadEvent[]) {
    const known = new Set(this.events.map((event) => `${event.at}|${event.title}`));
    const missing = events.filter((event) => !known.has(`${event.at}|${event.title}`));
    if (!missing.length) return 0;
    this.events = [...this.events, ...missing].sort((a, b) => a.at.localeCompare(b.at));
    await this.save();
    return missing.length;
  }

  async record(event: DownloadEvent) { this.events.push(event); await this.save(); }

  summary(days: number) { return summarize(this.events, days); }

  private save() {
    if (this.events.length > LIMIT) this.events = this.events.slice(-LIMIT);
    this.chain = this.chain.then(async () => {
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(this.events), { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.chain;
  }
}
