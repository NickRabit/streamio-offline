import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Odkud provoz teče. Knihovna čte soubor z disku, takže linku ven nezatěžuje --
 * proto se drží stranou a nemíchá se do čísel o externím provozu. */
export type TrafficSource = "download" | "catalog" | "library";

export const SOURCE_LABEL: Record<TrafficSource, string> = {
  download: "Stahování",
  catalog: "Přehrávání z katalogu",
  library: "Přehrávání z knihovny",
};

export const isExternal = (event: TrafficEvent) => event.source !== "library";

/** Popis jednoho přenosu. Samotné bajty přitékají po částech, tohle je to,
 * co jim dává jméno -- a zároveň klíč, pod kterým se přírůstky sčítají. */
export interface TrafficMeta {
  source: TrafficSource;
  provider: string;
  addonKey?: string;
  addonName?: string;
  title: string;
  kind: "movie" | "episode" | "other";
}

export interface TrafficEvent extends TrafficMeta {
  at: string;
  bytes: number;
  /** Kolik dokončených položek záznam představuje. Průběžné přírůstky mají nulu,
   * jinak by se jeden film počítal tolikrát, kolikrát se během něj zapisovalo. */
  items: number;
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
  sources: Bucket[];
  byProvider: Series[];
  byAddon: Series[];
  bySource: Series[];
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

const window = (events: TrafficEvent[], from: number): Window => {
  let bytes = 0; let count = 0;
  for (const event of events) if (Date.parse(event.at) >= from) { bytes += event.bytes; count += event.items; }
  return { bytes, count };
};

const identify = {
  provider: (event: TrafficEvent) => ({ key: event.provider, label: event.provider }),
  addon: (event: TrafficEvent) => ({ key: event.addonKey ?? event.provider, label: event.addonName ?? event.provider }),
  source: (event: TrafficEvent) => ({ key: event.source, label: SOURCE_LABEL[event.source] }),
};

/** Souhrn za zvolený počet hodin. Okna (hodina, den, týden, měsíc) se počítají
 * nezávisle na něm, aby karty ukazovaly totéž bez ohledu na vybrané období.
 *
 * Karty, sloupcový graf i rozpady podle zdroje a doplňku mluví jen o externím
 * provozu; přehrávání z knihovny se objeví jedině v rozpadu podle druhu provozu,
 * odkud se dá přidat do grafu jako vlastní linka. */
export function summarize(events: TrafficEvent[], hours = 720, now = new Date()): Summary {
  const span = Math.max(1, Math.min(24 * 365, hours));
  const edges = boundaries(span, now);

  const points = edges.map((at) => ({ at: new Date(at).toISOString(), bytes: 0, count: 0 }));
  const totals = { provider: new Map<string, Bucket>(), addon: new Map<string, Bucket>(), source: new Map<string, Bucket>() };
  const lines = { provider: new Map<string, Series>(), addon: new Map<string, Series>(), source: new Map<string, Series>() };

  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at)) continue;
    const index = slot(edges, at);
    if (index < 0) continue;

    const external = isExternal(event);
    if (external) { points[index].bytes += event.bytes; points[index].count += event.items; }

    for (const kind of (external ? ["provider", "addon", "source"] : ["source"]) as Array<keyof typeof totals>) {
      const { key, label } = identify[kind](event);
      const bucket = totals[kind].get(key) ?? { key, label, bytes: 0, count: 0 };
      bucket.bytes += event.bytes; bucket.count += event.items;
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
  const sources = ranked(totals.source);
  const external = events.filter(isExternal);

  return {
    hour: window(external, now.getTime() - HOUR),
    day: window(external, now.getTime() - DAY),
    week: window(external, now.getTime() - 7 * DAY),
    month: window(external, now.getTime() - 30 * DAY),
    total: window(external, 0),
    step: stepFor(span),
    points,
    providers,
    addons,
    sources,
    byProvider: ordered(lines.provider, providers),
    byAddon: ordered(lines.addon, addons),
    bySource: ordered(lines.source, sources),
    since: events.reduce<string | undefined>((oldest, event) => (!oldest || event.at < oldest ? event.at : oldest), undefined),
  };
}

/** Starší záznamy se slučují po hodinách. Jemnější krok než hodinu graf ukazuje
 * jen u posledních 24 hodin, takže se sloučením nic neztratí a soubor neroste
 * podle toho, jak dlouho přenosy trvaly. */
export function compact(events: TrafficEvent[], before: number): TrafficEvent[] {
  const merged = new Map<string, TrafficEvent>();
  const recent: TrafficEvent[] = [];
  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at) || at >= before) { recent.push(event); continue; }
    const hour = Math.floor(at / HOUR) * HOUR;
    const key = `${hour}|${event.source}|${event.provider}|${event.addonKey ?? ""}|${event.title}|${event.kind}`;
    const bucket = merged.get(key);
    if (bucket) { bucket.bytes += event.bytes; bucket.items += event.items; }
    else merged.set(key, { ...event, at: new Date(hour).toISOString() });
  }
  if (!merged.size) return events;
  return [...merged.values(), ...recent].sort((a, b) => a.at.localeCompare(b.at));
}

/** Nejstarší záznamy se zahazují, aby soubor nerostl donekonečna. */
const LIMIT = 20_000;
/** Jak často se nasbírané přírůstky ukládají. Nejjemnější krok grafu je pět
 * minut, takže minuta je dost jemná a soubor se přitom nezapisuje pořád. */
const FLUSH_MS = 60_000;

export class StatsLog {
  private events: TrafficEvent[] = [];
  /** Rozdělané přírůstky, které ještě nedostaly svůj záznam. */
  private pending = new Map<string, { meta: TrafficMeta; bytes: number; items: number }>();
  private file: string;
  private chain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private compactedAt = 0;

  constructor(dataDir = process.env.DATA_DIR ?? "/data") { this.file = path.join(dataDir, "stats.json"); }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const stored: Array<Partial<TrafficEvent>> = JSON.parse(await readFile(this.file, "utf8"));
      // Starší soubor zná jen dokončená stahování a pole source ani items nemá.
      this.events = stored.map((event) => ({ ...event, source: event.source ?? "download", items: event.items ?? 1 } as TrafficEvent));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Časovač drží rozdělané přírůstky nejvýš minutu; unref, ať kvůli němu
    // server nezůstane naživu, až bude chtít skončit.
    if (!this.timer) { this.timer = setInterval(() => void this.flush(), FLUSH_MS); this.timer.unref(); }
    return this.events.length;
  }

  /** Doplní historii z fronty jen tam, kam vlastní záznam nesahá. Od chvíle, kdy
   * stats.json vznikl, je úplný, takže chybět mohou jedině starší úlohy -- a jen
   * ty se tedy doplňují, ať se nezdvojí to, co už je zapsané. */
  async seed(events: TrafficEvent[]) {
    const oldest = this.events.reduce<string | undefined>((found, event) => (!found || event.at < found ? event.at : found), undefined);
    const missing = events.filter((event) => !oldest || event.at < oldest);
    if (!missing.length) return 0;
    this.events = [...this.events, ...missing].sort((a, b) => a.at.localeCompare(b.at));
    await this.save();
    return missing.length;
  }

  /** Přičte přenesené bajty k rozdělanému přenosu; zapíší se při nejbližším uložení. */
  add(meta: TrafficMeta, bytes: number) {
    if (bytes <= 0) return;
    this.bucket(meta).bytes += bytes;
  }

  /** Dokončená položka. Ukládá se hned, ať se po dostažení pozná na statistikách. */
  complete(meta: TrafficMeta, bytes = 0) {
    const bucket = this.bucket(meta);
    bucket.bytes += Math.max(0, bytes);
    bucket.items += 1;
    return this.flush();
  }

  private bucket(meta: TrafficMeta) {
    const key = `${meta.source}|${meta.provider}|${meta.addonKey ?? ""}|${meta.title}|${meta.kind}`;
    const found = this.pending.get(key);
    if (found) return found;
    const fresh = { meta, bytes: 0, items: 0 };
    this.pending.set(key, fresh);
    return fresh;
  }

  /** Rozdělané přírůstky se překlopí do záznamů s časem, kdy provoz opravdu tekl. */
  flush() {
    if (!this.pending.size) return this.chain;
    const at = new Date().toISOString();
    for (const { meta, bytes, items } of this.pending.values()) {
      if (bytes || items) this.events.push({ ...meta, at, bytes, items });
    }
    this.pending.clear();
    return this.save();
  }

  summary(hours: number) { this.flush(); return summarize(this.events, hours); }

  private save() {
    const now = Date.now();
    if (now - this.compactedAt > HOUR) { this.events = compact(this.events, now - DAY); this.compactedAt = now; }
    if (this.events.length > LIMIT) this.events = this.events.slice(-LIMIT);
    this.chain = this.chain.then(async () => {
      const temp = `${this.file}.tmp`;
      await writeFile(temp, JSON.stringify(this.events), { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.chain;
  }
}
