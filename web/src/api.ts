import type { Diagnostics, BuildInfo, AuthStatus, StatsSummary, Addon, AddonDownloadSettings, Capabilities, Catalog, Download, Inspection, BrowseResult, LibraryPage, ProgressEntry, WatchlistEntry, LibrarySummary, Meta, PlaybackSession, SearchResult, Session, Settings, SettingsBackup, Stream, Subtitle } from "./types";

/** Stavový kód musí projít až nahoru, jinak nepoznáme odhlášení od běžné chyby. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

/** Every call gets a deadline. A stalled connection would otherwise be held until the
 * operating system gives up, which takes minutes, and six of those exhaust the browser's
 * per-origin pool -- the app then looks dead on that one device while others are fine. */
async function request<T>(url: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs = 30_000, ...init } = options ?? {};
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new ApiError("Server neodpověděl včas.", 408);
    throw error;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({} as { error?: string; code?: string }));
    throw new ApiError(body.error ?? `HTTP ${response.status}`, response.status, body.code);
  }
  return response.status === 204 ? undefined as T : response.json();
}
const q = (values: Record<string, string | number | undefined>) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

export const api = {
  addons: () => request<Addon[]>("/api/addons"),
  addAddon: (url: string, role: string) => request<Addon>("/api/addons", { method: "POST", body: JSON.stringify({ url, role }) }),
  moveAddon: (key: string, direction: -1 | 1) => request<void>(`/api/addons/${key}/move`, { method: "POST", body: JSON.stringify({ direction }) }),
  exportAddon: (key: string) => request<Record<string, unknown>>(`/api/addons/${key}/export`),
  deleteAddon: (key: string) => request<void>(`/api/addons/${key}`, { method: "DELETE" }),
  stats: (hours: number) => request<StatsSummary>(`/api/stats?hours=${hours}`),
  updateAddon: (key: string, patch: { enabled?: boolean; url?: string; role?: string; downloadSettings?: AddonDownloadSettings }) => request<Addon>(`/api/addons/${key}`, { method: "PATCH", body: JSON.stringify(patch) }),
  toggleAddon: (key: string, enabled: boolean) => request<Addon>(`/api/addons/${key}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  catalogs: () => request<Catalog[]>("/api/catalogs"),
  catalog: (catalog: Catalog, search = "", skip = 0, genre = "") => request<Meta[]>(`/api/catalog?${q({ addon: catalog.addonKey, type: catalog.type, id: catalog.id, search: search || undefined, skip: skip || undefined, genre: genre || undefined })}`),
  search: (query: string, type = "", cursor = "", addon = "") => request<SearchResult>(`/api/search?${q({ query, type: type || undefined, cursor: cursor || undefined, addon: addon || undefined })}`),
  searchable: () => request<Array<{ addonKey: string; addonName: string; type: string; id: string }>>("/api/searchable"),
  meta: (type: string, id: string) => request<Meta>(`/api/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  streamSources: (type: string, id: string) => request<Array<{ key: string; name: string }>>(`/api/stream-sources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  streams: (type: string, id: string, addon?: string) => request<Stream[]>(`/api/streams/${encodeURIComponent(type)}/${encodeURIComponent(id)}${addon ? `?addon=${encodeURIComponent(addon)}` : ""}`),
  subtitles: (type: string, id: string) => request<Subtitle[]>(`/api/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  downloads: (timeoutMs?: number) => request<Download[]>("/api/downloads", { timeoutMs }),
  download: (title: string, stream: Stream, media?: Record<string, unknown>) => request<Download>("/api/downloads", { method: "POST", body: JSON.stringify({ title, stream, media }) }),
  downloadBulk: (title: string, type: string, episodes: Array<{ id: string; season?: number; episode?: number; title?: string }>, media?: { id?: string; metaType?: string; poster?: string }) => request<{ added: number; skipped: number }>("/api/downloads/bulk", { method: "POST", body: JSON.stringify({ title, type, episodes, media }) }),
  downloadAction: (id: string, action: "pause" | "resume" | "retry") => request<void>(`/api/downloads/${id}/${action}`, { method: "POST" }),
  moveDownload: (id: string, direction: -1 | 1) => request<void>(`/api/downloads/${id}/move`, { method: "POST", body: JSON.stringify({ direction }) }),
  removeDownload: (id: string) => request<void>(`/api/downloads/${id}`, { method: "DELETE" }),
  clearCompleted: () => request<void>("/api/downloads", { method: "DELETE" }),
  settings: () => request<Settings>("/api/settings"),
  updateSettings: (patch: Partial<Settings>) => request<Settings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  exportSettings: () => request<SettingsBackup>("/api/settings/export"),
  importSettings: (backup: unknown) => request<{ settings: Settings; addons: Addon[] }>("/api/settings/import", { method: "POST", body: JSON.stringify(backup), timeoutMs: 120_000 }),
  languages: () => request<Array<{ code: string; name: string }>>("/api/languages"),
  inspect: (stream: Stream) => request<Inspection>("/api/inspect", { method: "POST", body: JSON.stringify({ stream }) }),
  logs: (options: { tail?: number; level?: string; hours?: number; search?: string; inline?: boolean } = {}) =>
    fetch(`/api/logs?${q({ tail: options.tail, level: options.level || undefined, hours: options.hours || undefined, q: options.search || undefined, inline: options.inline ? 1 : undefined })}`)
      .then(async (response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); }),
  clearLogs: () => request<void>("/api/logs", { method: "DELETE" }),
  diagnostics: () => request<Diagnostics>("/api/diagnostics"),
  startPlayback: (stream: Stream, capabilities: Capabilities, time = 0) => request<PlaybackSession>("/api/playback", { method: "POST", body: JSON.stringify({ stream, capabilities, time }) }),
  setTrack: (id: string, changes: { audio?: number; subtitle?: number | null; quality?: number | null; time: number }) => request<PlaybackSession>(`/api/playback/${id}/track`, { method: "POST", body: JSON.stringify(changes) }),
  seekPlayback: (id: string, time: number) => request<PlaybackSession>(`/api/playback/${id}/seek`, { method: "POST", body: JSON.stringify({ time }) }),
  stopPlayback: (id: string) => request<void>(`/api/playback/${id}`, { method: "DELETE" }),
  library: () => request<LibrarySummary[]>("/api/library"),
  deleteLibraryItem: (path: string) => request<void>(`/api/library/item?${q({ path })}`, { method: "DELETE" }),
  renameLibraryItem: (path: string, name: string) => request<{ path: string }>("/api/library/rename", { method: "POST", body: JSON.stringify({ path, name }) }),
  watchlist: () => request<WatchlistEntry[]>("/api/watchlist"),
  setWatchlist: (payload: { type: string; id: string; name?: string; poster?: string; favorite: boolean }) =>
    request<{ key: string; favorite: boolean }>("/api/watchlist", { method: "POST", body: JSON.stringify(payload) }),
  progressList: () => request<ProgressEntry[]>("/api/progress"),
  progressOf: (key: string) => request<ProgressEntry | null>(`/api/progress/${encodeURIComponent(key)}`),
  saveProgress: (payload: { key: string; position: number; duration: number; title?: string; path?: string; poster?: string }) =>
    request<void>("/api/progress", { method: "POST", body: JSON.stringify(payload) }),
  clearProgress: () => request<void>("/api/progress", { method: "DELETE" }),
  forgetProgress: (key: string) => request<void>(`/api/progress/${encodeURIComponent(key)}`, { method: "DELETE" }),
  setFavorite: (path: string, favorite: boolean) => request<{ path: string; favorite: boolean }>("/api/library/favorite", { method: "POST", body: JSON.stringify({ path, favorite }) }),
  favorites: (options: { skip?: number; limit?: number; sort?: string; order?: string; seed?: string }) =>
    request<BrowseResult>(`/api/library/favorites?${q({ skip: options.skip || undefined, limit: options.limit ?? 60, sort: options.sort || undefined, order: options.order || undefined, seed: options.seed || undefined })}`),
  browse: (options: { path?: string; query?: string; skip?: number; limit?: number; sort?: string; order?: string; seed?: string; favorites?: boolean }) =>
    request<BrowseResult>(`/api/library/browse?${q({
      path: options.path || undefined, query: options.query || undefined,
      skip: options.skip || undefined, limit: options.limit ?? 60,
      sort: options.sort || undefined, order: options.order || undefined, seed: options.seed || undefined,
      favorites: options.favorites ? 1 : undefined,
    })}`),
  libraryEntry: (key: string, query = "", skip = 0, limit = 100) =>
    request<LibraryPage>(`/api/library/entry?${q({ key, query: query || undefined, skip: skip || undefined, limit })}`),
  status: () => request<BuildInfo>("/api/status"),
  me: () => request<AuthStatus>("/api/auth/me"),
  setup: (username: string, password: string) => request<Session>("/api/auth/setup", { method: "POST", body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string, remember: boolean) => request<Session>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password, remember }) }),
  logout: (everywhere = false) => request<void>("/api/auth/logout", { method: "POST", body: JSON.stringify({ everywhere }) }),
  changeCredentials: (payload: { username?: string; currentPassword?: string; newPassword: string }) => request<Session>("/api/auth/password", { method: "PATCH", body: JSON.stringify(payload) }),
};

export const subtitleUrl = (url: string, offset = 0) => `/api/subtitle?${new URLSearchParams(offset ? { url, offset: offset.toFixed(3) } : { url })}`;
