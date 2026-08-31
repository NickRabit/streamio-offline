import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const normalized = ip.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

export async function validateRemoteUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw.replace(/^stremio:\/\//i, "https://")); }
  catch { throw new Error("Neplatná URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Podporované jsou pouze HTTP(S) adresy.");
  if (url.username || url.password) throw new Error("Přihlašovací údaje nesmí být v authority části URL.");
  if (process.env.ALLOW_PRIVATE_ADDONS === "1") return url;
  const results = await dns.lookup(url.hostname, { all: true });
  if (!results.length || results.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("Adresy v privátní síti jsou blokované. Pro vlastní doplněk nastavte ALLOW_PRIVATE_ADDONS=1.");
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
  };
}
