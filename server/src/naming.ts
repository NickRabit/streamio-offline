import path from "node:path";

export interface MediaInfo {
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

/** Film jde do vlastní složky, epizoda do složky seriálu a série. Knihovny to tak čekají. */
export function targetPath(media: MediaInfo | undefined, fallbackTitle: string, extension: string): { directory: string; base: string } {
  if (media?.kind === "episode" && media.title?.trim()) {
    const series = safeName(media.title);
    const directory = media.season == null ? series : path.join(series, `${pad(media.season)} serie`);
    const number = media.episode == null ? "" : pad(media.episode);
    const name = media.episodeTitle?.trim() ? safeName(media.episodeTitle) : "";
    const base = [number, name].filter(Boolean).join(" - ") || safeName(fallbackTitle);
    return { directory, base };
  }
  const title = safeName(media?.title?.trim() || fallbackTitle);
  return { directory: title, base: title };
}

export const joinTarget = (directory: string, base: string, extension: string, copy = 1) =>
  path.join(directory, `${base}${copy > 1 ? ` (${copy})` : ""}${extension}`);
