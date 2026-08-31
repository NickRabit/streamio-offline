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
};

export function playableStream(stream: Stream): Stream {
  if (!stream.url) return stream;
  const headers = stream.behaviorHints?.proxyHeaders?.request;
  const params = new URLSearchParams({ url: stream.url });
  if (headers && Object.keys(headers).length) params.set("headers", btoa(unescape(encodeURIComponent(JSON.stringify(headers)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  return { ...stream, url: `/api/proxy?${params}` };
}

