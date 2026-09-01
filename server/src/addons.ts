import { createHash, randomUUID } from "node:crypto";
import type { AddonRecord, AddonRole, CatalogDefinition, MetaItem, StremioManifest, StreamItem, SubtitleItem } from "./types.js";
import { safeFetch, validateRemoteUrl } from "./security.js";

const TIMEOUT_MS = 12_000;
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_ADDON_TIMEOUT_MS ?? 60_000);

async function jsonFetch<T>(rawUrl: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const url = await validateRemoteUrl(rawUrl);
  const response = await safeFetch(url.toString(), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "user-agent": "StremioOffline/0.1" },
  });
  if (!response.ok) throw new Error(`Doplněk odpověděl HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) throw new Error("Doplněk nevrátil JSON.");
  return response.json() as Promise<T>;
}

export async function loadAddon(rawUrl: string, role: AddonRole): Promise<AddonRecord> {
  const url = await validateRemoteUrl(rawUrl);
  if (!url.pathname.endsWith("/manifest.json") && url.pathname !== "/manifest.json") {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/manifest.json`;
  }
  const manifest = await jsonFetch<StremioManifest>(url.toString());
  if (!manifest.id || !manifest.name || !manifest.version) throw new Error("Manifest nemá povinné údaje id, name a version.");
  return {
    key: randomUUID(), manifestUrl: url.toString(), role, enabled: true,
    addedAt: new Date().toISOString(), manifest,
  };
}

function baseUrl(addon: AddonRecord): URL { return new URL("./", addon.manifestUrl); }
function resourceUrl(addon: AddonRecord, resource: string, type: string, id: string, extras?: Record<string, string | number>) {
  const base = baseUrl(addon);
  const parts = [resource, encodeURIComponent(type), encodeURIComponent(id)];
  if (extras && Object.keys(extras).length) {
    parts.push(Object.entries(extras).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&"));
  }
  return new URL(`${parts.join("/")}.json`, base).toString();
}

function supports(addon: AddonRecord, resource: string, type: string, id?: string): boolean {
  const declared = addon.manifest.resources ?? [];
  const match = declared.find((entry) => typeof entry === "string" ? entry === resource : entry.name === resource);
  if (!match) return false;
  if (typeof match !== "string" && match.types?.length && !match.types.includes(type)) return false;
  const prefixes = typeof match !== "string" ? match.idPrefixes : addon.manifest.idPrefixes;
  return !id || !prefixes?.length || prefixes.some((prefix) => id.startsWith(prefix));
}

export async function catalog(addon: AddonRecord, type: string, catalogId: string, search?: string, skip = 0, genre?: string) {
  const extras: Record<string, string | number> = {};
  if (search) extras.search = search;
  if (genre) extras.genre = genre;
  if (skip) extras.skip = skip;
  const response = await jsonFetch<{ metas?: MetaItem[] }>(resourceUrl(addon, "catalog", type, catalogId, extras));
  return response.metas ?? [];
}

/** Doplňky deklarují podporu extras třemi různými způsoby, protokol se v čase měnil. */
function declaresExtra(definition: CatalogDefinition, name: string): boolean {
  if (definition.extra?.some((item) => item.name === name)) return true;
  return Array.isArray(definition.extraSupported) && definition.extraSupported.includes(name);
}

function requiredExtras(definition: CatalogDefinition): string[] {
  const fromExtra = (definition.extra ?? []).filter((item) => item.isRequired).map((item) => item.name);
  return [...new Set([...fromExtra, ...(definition.extraRequired ?? [])])];
}

/** Katalogy, do kterých má smysl poslat dotaz: umí search a nechtějí nic, co neumíme dodat. */
export function searchableCatalogs(addons: AddonRecord[], type?: string, addonKey?: string) {
  return addons.filter((addon) => addon.enabled && addon.role !== "source" && (!addonKey || addon.key === addonKey)).flatMap((addon) =>
    (addon.manifest.catalogs ?? [])
      .filter((definition) => (!type || definition.type === type) && declaresExtra(definition, "search"))
      .filter((definition) => requiredExtras(definition).every((name) => name === "search"))
      .map((definition) => ({ addon, definition })));
}

export interface SearchResult { items: MetaItem[]; cursor: string; hasMore: boolean; sources: number }

/** Každý zdroj vrací jinak velké dávky, takže si každý nese vlastní posun. Společné číslo
 *  by u menších katalogů přeskočilo položky, které ještě nikdo neviděl. -1 znamená vyčerpáno. */
const decodeCursor = (cursor?: string): Record<string, number> => {
  if (!cursor) return {};
  try { return JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, number>; }
  catch { return {}; }
};
const encodeCursor = (offsets: Record<string, number>) => Buffer.from(JSON.stringify(offsets)).toString("base64url");

/** Stremio se ptá všech doplňků naráz; jeden pomalý nebo rozbitý nesmí shodit zbytek. */
export async function searchAll(addons: AddonRecord[], query: string, type: string | undefined, cursor?: string, addonKey?: string): Promise<SearchResult> {
  const targets = searchableCatalogs(addons, type, addonKey);
  const offsets = decodeCursor(cursor);
  const nextOffsets: Record<string, number> = {};

  const settled = await Promise.allSettled(targets.map(async ({ addon, definition }) => {
    const key = `${addon.key}:${definition.type}:${definition.id}`;
    const from = offsets[key] ?? 0;
    if (from < 0) return { key, from, metas: [] as MetaItem[] };
    const metas = await catalog(addon, definition.type, definition.id, query, from);
    return { key, from, metas: metas.map((meta) => ({ ...meta, type: meta.type || definition.type, addonName: addon.manifest.name })) };
  }));

  const seen = new Map<string, MetaItem>();
  settled.forEach((result, index) => {
    const { addon, definition } = targets[index];
    const key = `${addon.key}:${definition.type}:${definition.id}`;
    if (result.status === "rejected") {
      console.warn(`Hledání v ${addon.manifest.name} selhalo: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      nextOffsets[key] = -1;
      return;
    }
    const { from, metas } = result.value;
    nextOffsets[key] = metas.length ? from + metas.length : -1;
    for (const meta of metas) {
      const id = `${meta.type}:${meta.id}`;
      const existing = seen.get(id);
      if (existing) { const sources = (existing.sources as string[]) ?? []; if (!sources.includes(String(meta.addonName))) sources.push(String(meta.addonName)); existing.sources = sources; }
      else seen.set(id, { ...meta, sources: [String(meta.addonName)] });
    }
  });

  return {
    items: [...seen.values()],
    cursor: encodeCursor(nextOffsets),
    hasMore: Object.values(nextOffsets).some((offset) => offset >= 0),
    sources: targets.length,
  };
}

export async function metadata(addons: AddonRecord[], type: string, id: string) {
  for (const addon of addons.filter((a) => a.enabled && a.role !== "source" && supports(a, "meta", type, id))) {
    try {
      const response = await jsonFetch<{ meta?: MetaItem }>(resourceUrl(addon, "meta", type, id));
      if (response.meta) return response.meta;
    } catch { /* try next metadata provider */ }
  }
  return null;
}

export async function streams(addons: AddonRecord[], type: string, id: string): Promise<StreamItem[]> {
  const candidates = addons.filter((a) => a.enabled && a.role !== "catalog" && supports(a, "stream", type, id));
  const results = await Promise.allSettled(candidates.map(async (addon) => {
    const response = await jsonFetch<{ streams?: StreamItem[] }>(resourceUrl(addon, "stream", type, id), STREAM_TIMEOUT_MS);
    return (response.streams ?? []).map((stream) => ({ ...stream, addonKey: addon.key, addonName: addon.manifest.name }));
  }));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.warn(`Zdrojový doplněk ${candidates[index].manifest.name} selhal: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

export async function subtitles(addons: AddonRecord[], type: string, id: string): Promise<SubtitleItem[]> {
  const candidates = addons.filter((a) => a.enabled && supports(a, "subtitles", type, id));
  const results = await Promise.allSettled(candidates.map(async (addon) => {
    const response = await jsonFetch<{ subtitles?: SubtitleItem[] }>(resourceUrl(addon, "subtitles", type, id));
    return (response.subtitles ?? []).map((subtitle) => ({ ...subtitle, addonName: addon.manifest.name }));
  }));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.warn(`Titulkový doplněk ${candidates[index].manifest.name} selhal: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

export function streamToken(stream: StreamItem): string {
  return createHash("sha256").update(JSON.stringify(stream)).digest("hex").slice(0, 32);
}
