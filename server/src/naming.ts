import path from "node:path";
import type { AddonDownloadSettings, DownloadLayout, DownloadTargetSettings } from "./types.js";

export interface MediaInfo {
  /** IMDb id z katalogu. Díky němu nemusíme metadata hádat z názvu složky. */
  id?: string;
  metaType?: string;
  /** Plakát z katalogu. Klient ho má po ruce, takže se nemusí dohledávat přes metadata. */
  poster?: string;
  kind?: "movie" | "episode";
  /** Název filmu, nebo název seriálu u epizody. */
  title?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

// Zpětné lomítko je tu kvůli sdíleným složkám z Windows a taky proto,
// aby se název nedal použít k útěku z cílového adresáře.
const FORBIDDEN = /[\u0000-\u001f/:*?"<>|\\]/g;

export function safeName(value: string): string {
  const cleaned = value.normalize("NFC")
    .replace(FORBIDDEN, " ")
    // Ze "../.." zbudou po odstranění lomítek osamocené tečky; jako část názvu nedávají smysl.
    .split(/\s+/).filter((part) => part && !/^\.+$/.test(part)).join(" ")
    .replace(/^\.+/, "").replace(/\.+$/, "").trim();
  return cleaned.slice(0, 150).trim() || "video";
}

const pad = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");

export const defaultDownloadSettings = (): AddonDownloadSettings => ({
  movie: { subfolder: "", layout: "structured" },
  series: { subfolder: "", layout: "structured" },
});

/** Podsložka je relativní k /downloads. Povolujeme i více úrovní, ale nikdy
 * absolutní cestu, diskové písmeno ani . a .. segmenty. */
export function safeSubfolder(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^[\\/]/.test(raw) || /^[a-z]:/i.test(raw)) throw new Error("Podsložka musí být relativní k /downloads.");
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.length > 8) throw new Error("Podsložka může mít nejvýše 8 úrovní.");
  if (segments.some((segment) => segment === "." || segment === "..")) throw new Error("Podsložka nesmí obsahovat segment . ani segment ..");
  return segments.map(safeName).join(path.sep);
}

const targetSettings = (value: unknown): DownloadTargetSettings => {
  const item = typeof value === "object" && value ? value as Record<string, unknown> : {};
  const layout: DownloadLayout = item.layout === "flat" ? "flat" : "structured";
  return { subfolder: safeSubfolder(item.subfolder), layout };
};

export function normalizeDownloadSettings(value: unknown): AddonDownloadSettings {
  const item = typeof value === "object" && value ? value as Record<string, unknown> : {};
  return { movie: targetSettings(item.movie), series: targetSettings(item.series) };
}

/** Film jde do vlastní složky, epizoda do složky seriálu a série. Knihovny to tak čekají. */
export function targetPath(media: MediaInfo | undefined, fallbackTitle: string, extension: string, settings: DownloadTargetSettings = defaultDownloadSettings().movie): { directory: string; base: string } {
  const prefix = safeSubfolder(settings.subfolder);
  if (media?.kind === "episode" && media.title?.trim()) {
    const series = safeName(media.title);
    const number = media.episode == null ? "" : pad(media.episode);
    const name = media.episodeTitle?.trim() ? safeName(media.episodeTitle) : "";
    if (settings.layout === "flat") {
      const episodeCode = media.season == null ? number : `S${pad(media.season)}E${number || "00"}`;
      const base = [series, episodeCode, name].filter(Boolean).join(" - ") || safeName(fallbackTitle);
      return { directory: prefix, base };
    }
    const directory = path.join(prefix, series, ...(media.season == null ? [] : [`${pad(media.season)} serie`]));
    const base = [number, name].filter(Boolean).join(" - ") || safeName(fallbackTitle);
    return { directory, base };
  }
  const title = safeName(media?.title?.trim() || fallbackTitle);
  return { directory: settings.layout === "flat" ? prefix : path.join(prefix, title), base: title };
}

export const joinTarget = (directory: string, base: string, extension: string, copy = 1) =>
  path.join(directory, `${base}${copy > 1 ? ` (${copy})` : ""}${extension}`);
