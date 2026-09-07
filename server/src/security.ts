import { AppError } from "./errors.js";
import dns from "node:dns/promises";
import net from "node:net";
import { log } from "./logger.js";

/** Rozsahy, které nesmí server na pokyn zvenčí oslovit: vlastní stroj, LAN a metadata cloudu. */
function privateReason(ip: string): string | undefined {
  // ::ffff:10.0.0.1 je zápis IPv4 uvnitř IPv6; bez rozbalení by kontrola prošla naprázdno.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped ? mapped[1] : ip;

  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0) return "an unspecified address";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "a private network";
    if (a === 127) return "localhost";
    if (a === 169 && b === 254) return "link-local a metadata cloudu";
    if (a === 100 && b >= 64 && b <= 127) return "CGNAT";
    if (a === 198 && (b === 18 || b === 19)) return "a test range";
    if (a >= 224) return "a multicast or reserved range";
    return undefined;
  }

  const normalized = address.toLowerCase();
  if (normalized === "::1") return "localhost";
  if (normalized === "::") return "an unspecified address";
  if (/^f[cd]/.test(normalized)) return "a private network";
  if (normalized.startsWith("fe80:")) return "link-local";
  if (normalized.startsWith("ff")) return "multicast";
  return undefined;
}

const allowedHosts = new Set((process.env.ALLOW_ADDON_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));

export async function validateRemoteUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw.replace(/^stremio:\/\//i, "https://")); }
  catch { throw new AppError("Invalid URL.", "err.invalidUrl"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new AppError("Only HTTP(S) addresses are supported.", "err.onlyHttp");
  if (url.username || url.password) throw new AppError("Credentials must not sit in the authority part of a URL.", "err.credentialsInUrl");

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (process.env.ALLOW_PRIVATE_ADDONS === "1" || allowedHosts.has(host)) return url;

  let results: Array<{ address: string }>;
  try { results = await dns.lookup(host, { all: true }); }
  catch { throw new Error(`Název ${host} se nepodařilo přeložit na IP adresu.`); }
  if (!results.length) throw new Error(`Název ${host} nemá žádnou IP adresu.`);

  for (const entry of results) {
    const reason = privateReason(entry.address);
    if (reason) {
      log("WARN", "Blocked an address outside the public network", { host, ip: entry.address, reason });
      throw new Error(`${host} ukazuje na ${entry.address} (${reason}). Pokud je to váš vlastní doplněk, povolte ho pomocí ALLOW_ADDON_HOSTS=${host}, nebo celou LAN pomocí ALLOW_PRIVATE_ADDONS=1.`);
    }
  }
  return url;
}

const responseHeaders = new WeakMap<Response, Headers>();

export function upstreamRequestHeaders(response: Response): Headers {
  return new Headers(responseHeaders.get(response));
}

export async function safeFetch(raw: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let url = await validateRemoteUrl(raw);
  let headers = new Headers(init.headers);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      responseHeaders.set(response, headers);
      return response;
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Source redirect has no destination.");
    if (redirect === maxRedirects) throw new Error("The source exceeded the allowed number of redirects.");
    const next = await validateRemoteUrl(new URL(location, url).toString());
    headers = redirectedHeaders(headers, url, next);
    url = next;
  }
  throw new Error("The source redirect could not be followed.");
}

export function redirectedHeaders(input: HeadersInit, from: URL, to: URL): Headers {
  const headers = new Headers(input);
  if (from.origin === to.origin) return headers;
  const forwarded = new Headers();
  for (const name of ["accept", "accept-encoding", "accept-language", "range", "if-range", "user-agent"]) {
    const value = headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  return forwarded;
}

export function publicAddon(addon: import("./types.js").AddonRecord) {
  const url = new URL(addon.manifestUrl);
  const sensitivePath = url.pathname !== "/manifest.json";
  return {
    key: addon.key,
    role: addon.role,
    enabled: addon.enabled,
    addedAt: addon.addedAt,
    manifest: addon.manifest,
    displayUrl: `${url.origin}${sensitivePath ? "/…/manifest.json" : url.pathname}`,
    configurable: Boolean(addon.manifest.behaviorHints?.configurable),
    downloadSettings: addon.downloadSettings,
  };
}
