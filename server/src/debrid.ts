import { guardedFetch } from "./outbound.js";

export const RD_API = "https://api.real-debrid.com/rest/1.0";
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DebridError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "DebridError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const rdError = (status: number, code?: string, fallback?: string) => {
  if (status === 401 || code === "bad_token") return new DebridError("Token Real-Debrid není platný.", 401, code);
  if (status === 403) return new DebridError("Real-Debrid tento účet k API nepustil.", 403, code);
  if (status === 429 || status === 509) return new DebridError("Real-Debrid má plné sloty, zkusím to znovu.", status, code);
  if (status === 503 || code === "infringing_file") return new DebridError("Real-Debrid tenhle torrent odmítl.", 503, code);
  return new DebridError(fallback || `Real-Debrid odpověděl chybou (${status}).`, status, code);
};

async function rdRequest(token: string, path: string, body?: Record<string, string>, fetchImpl: FetchLike = guardedFetch): Promise<Response> {
  const init: RequestInit = {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: body ? new URLSearchParams(body).toString() : undefined,
  };
  const response = await fetchImpl(`${RD_API}${path}`, init);
  if (response.ok) return response;
  let code: string | undefined;
  let message: string | undefined;
  try {
    const payload = await response.json() as { error?: string; error_code?: number };
    code = typeof payload.error === "string" ? payload.error : undefined;
    message = code;
  } catch { /* Real-Debrid sometimes answers with an empty body. */ }
  throw rdError(response.status, code, message);
}

export interface DebridUser { username: string; premium: boolean }

export async function verifyRealDebridToken(token: string, fetchImpl: FetchLike = guardedFetch): Promise<DebridUser> {
  const value = normalizeToken(token);
  if (!value) throw new DebridError("Zadejte API token Real-Debrid.");
  const response = await rdRequest(value, "/user", undefined, fetchImpl);
  const body = await response.json() as { username?: string; type?: string; premium?: number };
  const premium = body.type === "premium" || Number(body.premium) > 0;
  if (!premium) throw new DebridError("Účet Real-Debrid není premium.");
  return { username: String(body.username ?? ""), premium };
}

const INFO_HASH = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg|iso)$/i;
const FAILED = new Set(["error", "virus", "dead", "magnet_error"]);

export function magnetFromHash(infoHash: string): string {
  const hash = infoHash.trim().toLowerCase();
  if (!INFO_HASH.test(hash)) throw new DebridError("Torrent nemá platný infoHash.");
  return `magnet:?xt=urn:btih:${hash}`;
}

export interface DebridFile { id: number; path: string; bytes: number; selected: number }
export interface DebridTorrent {
  id: string;
  filename?: string;
  status: string;
  progress?: number;
  files?: DebridFile[];
  links?: string[];
}
export interface UnrestrictedLink { download: string; filename?: string; filesize?: number }

export async function addMagnet(token: string, magnet: string, fetchImpl: FetchLike = guardedFetch): Promise<string> {
  const response = await rdRequest(token, "/torrents/addMagnet", { magnet }, fetchImpl);
  const body = await response.json() as { id?: string };
  if (!body.id) throw new DebridError("Real-Debrid nevrátil identifikátor torrentu.");
  return body.id;
}

export async function selectFiles(token: string, torrentId: string, files: string, fetchImpl: FetchLike = guardedFetch): Promise<void> {
  await rdRequest(token, `/torrents/selectFiles/${encodeURIComponent(torrentId)}`, { files }, fetchImpl);
}

export async function torrentInfo(token: string, torrentId: string, fetchImpl: FetchLike = guardedFetch): Promise<DebridTorrent> {
  const response = await rdRequest(token, `/torrents/info/${encodeURIComponent(torrentId)}`, undefined, fetchImpl);
  return await response.json() as DebridTorrent;
}

export async function unrestrictLink(token: string, link: string, fetchImpl: FetchLike = guardedFetch): Promise<UnrestrictedLink> {
  const response = await rdRequest(token, "/unrestrict/link", { link }, fetchImpl);
  const body = await response.json() as UnrestrictedLink;
  if (!body.download) throw new DebridError("Real-Debrid nevrátil stažitelnou adresu.");
  return body;
}

export function videoFileIds(files: DebridFile[] | undefined, fileIdx?: number): string {
  const list = files ?? [];
  if (fileIdx != null && list[fileIdx]) return String(list[fileIdx].id);
  if (fileIdx != null) {
    const byId = list.find((file) => file.id === fileIdx + 1);
    if (byId) return String(byId.id);
  }
  const videos = list.filter((file) => VIDEO_EXT.test(file.path));
  if (videos.length) return videos.map((file) => file.id).join(",");
  if (list.length) return list.map((file) => file.id).join(",");
  return "all";
}

export function linkForFile(info: DebridTorrent, fileIdx?: number): string {
  const links = (info.links ?? []).filter(Boolean);
  if (!links.length) throw new DebridError("Real-Debrid torrent nemá žádný odkaz.");
  const selected = (info.files ?? []).filter((file) => file.selected);
  if (fileIdx != null) {
    const wanted = (info.files ?? [])[fileIdx] ?? (info.files ?? []).find((file) => file.id === fileIdx + 1);
    if (wanted) {
      const index = selected.findIndex((file) => file.id === wanted.id);
      if (index >= 0 && links[index]) return links[index];
    }
  }
  if (selected.length === links.length) {
    let best = 0;
    for (let index = 1; index < selected.length; index += 1) if (selected[index].bytes > selected[best].bytes) best = index;
    return links[best] ?? links[0];
  }
  return links[0];
}

export type DebridAdvance =
  | { ready: true; url: string; filename?: string; torrentId: string }
  | { ready: false; torrentId: string; progress?: number; status: string };

export async function advanceTorrent(
  token: string,
  infoHash: string,
  fileIdx: number | undefined,
  torrentId: string | undefined,
  fetchImpl: FetchLike = guardedFetch,
): Promise<DebridAdvance> {
  let id = torrentId;
  if (!id) {
    id = await addMagnet(token, magnetFromHash(infoHash), fetchImpl);
    const created = await torrentInfo(token, id, fetchImpl);
    if (created.status === "waiting_files_selection" || created.status === "magnet_conversion" || !created.links?.length) {
      await selectFiles(token, id, videoFileIds(created.files, fileIdx), fetchImpl);
    }
  }
  const info = await torrentInfo(token, id, fetchImpl);
  if (FAILED.has(info.status)) throw new DebridError("Real-Debrid torrent selhal.", 400, info.status);
  if (info.status === "downloaded" && info.links?.length) {
    const unrestricted = await unrestrictLink(token, linkForFile(info, fileIdx), fetchImpl);
    return { ready: true, url: unrestricted.download, filename: unrestricted.filename, torrentId: id };
  }
  return { ready: false, torrentId: id, progress: Number(info.progress) || 0, status: info.status };
}

/** Instant play/inspect: only when Real-Debrid already has the file. */
export async function resolveIfReady(
  token: string,
  infoHash: string,
  fileIdx: number | undefined,
  fetchImpl: FetchLike = guardedFetch,
): Promise<UnrestrictedLink | undefined> {
  const step = await advanceTorrent(token, infoHash, fileIdx, undefined, fetchImpl);
  if (!step.ready) return undefined;
  return { download: step.url, filename: step.filename };
}
