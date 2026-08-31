import type { Addon, Catalog, Download, Meta, Stream, Subtitle } from "./types";

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
  toggleAddon: (key: string, enabled: boolean) => request<Addon>(`/api/addons/${key}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  catalogs: () => request<Catalog[]>("/api/catalogs"),
  catalog: (catalog: Catalog, search = "", skip = 0) => request<Meta[]>(`/api/catalog?${q({ addon: catalog.addonKey, type: catalog.type, id: catalog.id, search: search || undefined, skip: skip || undefined })}`),
  meta: (type: string, id: string) => request<Meta>(`/api/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  streams: (type: string, id: string) => request<Stream[]>(`/api/streams/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  subtitles: (type: string, id: string) => request<Subtitle[]>(`/api/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  downloads: () => request<Download[]>("/api/downloads"),
  download: (title: string, stream: Stream) => request<Download>("/api/downloads", { method: "POST", body: JSON.stringify({ title, stream }) }),
  downloadAction: (id: string, action: "pause" | "resume" | "retry") => request<void>(`/api/downloads/${id}/${action}`, { method: "POST" }),
  moveDownload: (id: string, direction: -1 | 1) => request<void>(`/api/downloads/${id}/move`, { method: "POST", body: JSON.stringify({ direction }) }),
  removeDownload: (id: string) => request<void>(`/api/downloads/${id}`, { method: "DELETE" }),
  clearCompleted: () => request<void>("/api/downloads", { method: "DELETE" }),
  settings: () => request<{ concurrentDownloads: number }>("/api/settings"),
  updateSettings: (concurrentDownloads: number) => request<{ concurrentDownloads: number }>("/api/settings", { method: "PATCH", body: JSON.stringify({ concurrentDownloads }) }),
  logs: () => fetch("/api/logs").then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); }),
  startPlayback: (stream: Stream) => request<{ id: string; url: string; mode: string }>("/api/playback", { method: "POST", body: JSON.stringify({ stream }) }),
  stopPlayback: (id: string) => request<void>(`/api/playback/${id}`, { method: "DELETE" }),
};

export function playableStream(stream: Stream): Stream {
  if (!stream.url) return stream;
  const headers = stream.behaviorHints?.proxyHeaders?.request;
  const params = new URLSearchParams({ url: stream.url });
  if (headers && Object.keys(headers).length) params.set("headers", btoa(unescape(encodeURIComponent(JSON.stringify(headers)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  return { ...stream, url: `/api/proxy?${params}` };
}
export const subtitleUrl = (url: string) => `/api/subtitle?${new URLSearchParams({ url })}`;
