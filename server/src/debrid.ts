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
