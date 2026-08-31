import { createHash, randomUUID } from "node:crypto";
import type { AddonRecord, AddonRole, MetaItem, StremioManifest, StreamItem, SubtitleItem } from "./types.js";
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

export async function catalog(addon: AddonRecord, type: string, catalogId: string, search?: string, skip = 0) {
  const extras: Record<string, string | number> = {};
  if (search) extras.search = search;
  if (skip) extras.skip = skip;
  const response = await jsonFetch<{ metas?: MetaItem[] }>(resourceUrl(addon, "catalog", type, catalogId, extras));
  return response.metas ?? [];
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
