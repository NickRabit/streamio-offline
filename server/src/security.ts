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
    if (a === 0) return "neurčená adresa";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "privátní síť";
    if (a === 127) return "localhost";
    if (a === 169 && b === 254) return "link-local a metadata cloudu";
    if (a === 100 && b >= 64 && b <= 127) return "CGNAT";
    if (a === 198 && (b === 18 || b === 19)) return "testovací rozsah";
    if (a >= 224) return "multicast nebo rezervovaný rozsah";
    return undefined;
  }

  const normalized = address.toLowerCase();
  if (normalized === "::1") return "localhost";
  if (normalized === "::") return "neurčená adresa";
  if (/^f[cd]/.test(normalized)) return "privátní síť";
  if (normalized.startsWith("fe80:")) return "link-local";
  if (normalized.startsWith("ff")) return "multicast";
  return undefined;
}

const allowedHosts = new Set((process.env.ALLOW_ADDON_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));

export async function validateRemoteUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw.replace(/^stremio:\/\//i, "https://")); }
  catch { throw new Error("Neplatná URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Podporované jsou pouze HTTP(S) adresy.");
  if (url.username || url.password) throw new Error("Přihlašovací údaje nesmí být v authority části URL.");

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (process.env.ALLOW_PRIVATE_ADDONS === "1" || allowedHosts.has(host)) return url;

  let results: Array<{ address: string }>;
  try { results = await dns.lookup(host, { all: true }); }
  catch { throw new Error(`Název ${host} se nepodařilo přeložit na IP adresu.`); }
  if (!results.length) throw new Error(`Název ${host} nemá žádnou IP adresu.`);

  for (const entry of results) {
    const reason = privateReason(entry.address);
    if (reason) {
      log("WARN", "Blokována adresa mimo veřejnou síť", { host, ip: entry.address, reason });
      throw new Error(`${host} ukazuje na ${entry.address} (${reason}). Pokud je to váš vlastní doplněk, povolte ho pomocí ALLOW_ADDON_HOSTS=${host}, nebo celou LAN pomocí ALLOW_PRIVATE_ADDONS=1.`);
    }
  }
  return url;
}

export async function safeFetch(raw: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let url = await validateRemoteUrl(raw);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirect === maxRedirects) throw new Error("Zdroj překročil povolený počet přesměrování.");
    url = await validateRemoteUrl(new URL(location, url).toString());
  }
  throw new Error("Nepodařilo se zpracovat přesměrování zdroje.");
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
