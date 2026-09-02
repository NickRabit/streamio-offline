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
export interface Series { key: string; label: string; points: number[] }
export interface Window { bytes: number; count: number }
export type Step = "minute" | "hour" | "day";

export interface Summary {
  hour: Window; day: Window; week: Window; month: Window; total: Window;
  step: Step;
  points: Array<{ at: string; bytes: number; count: number }>;
  providers: Bucket[];
  addons: Bucket[];
  byProvider: Series[];
  byAddon: Series[];
  since?: string;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** Krok grafu se řídí délkou období: hodina po pěti minutách, den po hodinách, delší po dnech. */
const stepFor = (hours: number): Step => hours <= 1 ? "minute" : hours <= 24 ? "hour" : "day";

/** Hranice sloupců. U dnů se posouváme přes setDate, ne přidáváním 24 hodin --
 * jinak by se řada na přelomu letního času rozjela o hodinu. */
function boundaries(hours: number, now: Date) {
  const step = stepFor(hours);
  if (step === "day") {
    const days = Math.max(1, Math.round(hours / 24));
    const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
    return Array.from({ length: days }, (_, index) => { const at = new Date(start); at.setDate(at.getDate() + index); return at.getTime(); });
  }
  const size = step === "minute" ? 5 * MINUTE : HOUR;
  const count = Math.max(1, Math.ceil((hours * HOUR) / size));
  const end = Math.floor(now.getTime() / size) * size;
  return Array.from({ length: count }, (_, index) => end - (count - 1 - index) * size);
}

/** Poslední hranice, která ještě není za časem události. */
const slot = (edges: number[], at: number) => {
  if (at < edges[0]) return -1;
  let low = 0, high = edges.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (edges[middle] <= at) low = middle; else high = middle - 1; }
  return low;
};

const window = (events: DownloadEvent[], from: number): Window => {
  let bytes = 0; let count = 0;
  for (const event of events) if (Date.parse(event.at) >= from) { bytes += event.bytes; count += 1; }
  return { bytes, count };
};

const identify = {
  provider: (event: DownloadEvent) => ({ key: event.provider, label: event.provider }),
  addon: (event: DownloadEvent) => ({ key: event.addonKey ?? event.provider, label: event.addonName ?? event.provider }),
};

/** Souhrn za zvolený počet hodin. Okna (hodina, den, týden, měsíc) se počítají
 * nezávisle na něm, aby karty ukazovaly totéž bez ohledu na vybrané období. */
export function summarize(events: DownloadEvent[], hours = 720, now = new Date()): Summary {
  const span = Math.max(1, Math.min(24 * 365, hours));
  const edges = boundaries(span, now);
  const from = edges[0];

  const points = edges.map((at) => ({ at: new Date(at).toISOString(), bytes: 0, count: 0 }));
  const totals = { provider: new Map<string, Bucket>(), addon: new Map<string, Bucket>() };
  const lines = { provider: new Map<string, Series>(), addon: new Map<string, Series>() };

  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at) || at < from) continue;
    const index = slot(edges, at);
    if (index < 0) continue;
    points[index].bytes += event.bytes; points[index].count += 1;

    for (const kind of ["provider", "addon"] as const) {
      const { key, label } = identify[kind](event);
      const bucket = totals[kind].get(key) ?? { key, label, bytes: 0, count: 0 };
      bucket.bytes += event.bytes; bucket.count += 1;
      totals[kind].set(key, bucket);

      const line = lines[kind].get(key) ?? { key, label, points: new Array(edges.length).fill(0) };
      line.points[index] += event.bytes;
      lines[kind].set(key, line);
    }
  }

  const ranked = (map: Map<string, Bucket>) => [...map.values()].sort((a, b) => b.bytes - a.bytes);
  const ordered = (map: Map<string, Series>, order: Bucket[]) => order.map((bucket) => map.get(bucket.key)!).filter(Boolean);
  const providers = ranked(totals.provider);
  const addons = ranked(totals.addon);

  return {
    hour: window(events, now.getTime() - HOUR),
    day: window(events, now.getTime() - DAY),
    week: window(events, now.getTime() - 7 * DAY),
    month: window(events, now.getTime() - 30 * DAY),
    total: window(events, 0),
    step: stepFor(span),
    points,
    providers,
    addons,
    byProvider: ordered(lines.provider, providers),
    byAddon: ordered(lines.addon, addons),
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

  summary(hours: number) { return summarize(this.events, hours); }

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
