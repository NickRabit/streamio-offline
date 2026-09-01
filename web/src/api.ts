import type { Addon, AddonDownloadSettings, Capabilities, Catalog, Download, Inspection, Meta, PlaybackSession, SearchResult, Settings, Stream, Subtitle } from "./types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...options?.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
const q = (values: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

export const api = {
  addons: () => request<Addon[]>("/api/addons"),
  addAddon: (url: string, role: string) => request<Addon>("/api/addons", { method: "POST", body: JSON.stringify({ url, role }) }),
  deleteAddon: (key: string) => request<void>(`/api/addons/${key}`, { method: "DELETE" }),
  updateAddon: (key: string, patch: { enabled?: boolean; downloadSettings?: AddonDownloadSettings }) => request<Addon>(`/api/addons/${key}`, { method: "PATCH", body: JSON.stringify(patch) }),
  toggleAddon: (key: string, enabled: boolean) => request<Addon>(`/api/addons/${key}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  catalogs: () => request<Catalog[]>("/api/catalogs"),
  catalog: (catalog: Catalog, search = "", skip = 0, genre = "") => request<Meta[]>(`/api/catalog?${q({ addon: catalog.addonKey, type: catalog.type, id: catalog.id, search: search || undefined, skip: skip || undefined, genre: genre || undefined })}`),
  search: (query: string, type = "", cursor = "", addon = "") => request<SearchResult>(`/api/search?${q({ query, type: type || undefined, cursor: cursor || undefined, addon: addon || undefined })}`),
  searchable: () => request<Array<{ addonKey: string; addonName: string; type: string; id: string }>>("/api/searchable"),
  meta: (type: string, id: string) => request<Meta>(`/api/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  streams: (type: string, id: string) => request<Stream[]>(`/api/streams/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  subtitles: (type: string, id: string) => request<Subtitle[]>(`/api/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  downloads: () => request<Download[]>("/api/downloads"),
  download: (title: string, stream: Stream, media?: Record<string, unknown>) => request<Download>("/api/downloads", { method: "POST", body: JSON.stringify({ title, stream, media }) }),
  downloadAction: (id: string, action: "pause" | "resume" | "retry") => request<void>(`/api/downloads/${id}/${action}`, { method: "POST" }),
  moveDownload: (id: string, direction: -1 | 1) => request<void>(`/api/downloads/${id}/move`, { method: "POST", body: JSON.stringify({ direction }) }),
  removeDownload: (id: string) => request<void>(`/api/downloads/${id}`, { method: "DELETE" }),
  clearCompleted: () => request<void>("/api/downloads", { method: "DELETE" }),
  settings: () => request<Settings>("/api/settings"),
  updateSettings: (patch: Partial<Settings>) => request<Settings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  languages: () => request<Array<{ code: string; name: string }>>("/api/languages"),
  inspect: (stream: Stream) => request<Inspection>("/api/inspect", { method: "POST", body: JSON.stringify({ stream }) }),
  logs: () => fetch("/api/logs").then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); }),
  startPlayback: (stream: Stream, capabilities: Capabilities, time = 0) => request<PlaybackSession>("/api/playback", { method: "POST", body: JSON.stringify({ stream, capabilities, time }) }),
  setTrack: (id: string, changes: { audio?: number; subtitle?: number | null; time: number }) => request<PlaybackSession>(`/api/playback/${id}/track`, { method: "POST", body: JSON.stringify(changes) }),
  seekPlayback: (id: string, time: number) => request<PlaybackSession>(`/api/playback/${id}/seek`, { method: "POST", body: JSON.stringify({ time }) }),
  stopPlayback: (id: string) => request<void>(`/api/playback/${id}`, { method: "DELETE" }),
};

export const subtitleUrl = (url: string, offset = 0) => `/api/subtitle?${new URLSearchParams(offset ? { url, offset: offset.toFixed(3) } : { url })}`;
