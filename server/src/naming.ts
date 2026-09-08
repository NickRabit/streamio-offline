import { AppError } from "./errors.js";
import path from "node:path";
import type { AddonDownloadSettings, DownloadLayout, DownloadTargetSettings, StreamItem } from "./types.js";

export interface MediaInfo {
  /** The IMDb id from the catalogue, so metadata need not be guessed from the folder name. */
  id?: string;
  metaType?: string;
  /** The poster from the catalogue. The client has it at hand, so it need not be looked up through metadata. */
  poster?: string;
  kind?: "movie" | "episode";
  /** The film's name, or the series name for an episode. */
  title?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

// The backslash is here for Windows shares, and also so a name cannot be used to
// escape the target directory.
const FORBIDDEN = /[\u0000-\u001f/:*?"<>|\\]/g;

export function safeName(value: string): string {
  const cleaned = value.normalize("NFC")
    .replace(FORBIDDEN, " ")
    // Stripping the slashes from "../.." leaves lone dots, which make no sense as part of a name.
    .split(/\s+/).filter((part) => part && !/^\.+$/.test(part)).join(" ")
    .replace(/^\.+/, "").replace(/\.+$/, "").trim();
  return cleaned.slice(0, 150).trim() || "video";
}

const pad = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");

export const defaultDownloadSettings = (): AddonDownloadSettings => ({
  movie: { subfolder: "", layout: "structured" },
  series: { subfolder: "", layout: "structured" },
});

/** The subfolder is relative to /downloads. Several levels are allowed, but never an
 * absolute path, a drive letter, or . and .. segments. */
export function safeSubfolder(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^[\\/]/.test(raw) || /^[a-z]:/i.test(raw)) throw new AppError("The subfolder has to be relative to /downloads.", "err.subfolderRelative");
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.length > 8) throw new AppError("The subfolder can be at most 8 levels deep.", "err.subfolderDepth");
  if (segments.some((segment) => segment === "." || segment === "..")) throw new AppError("The subfolder cannot contain . or .. segments.", "err.subfolderDots");
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

/** A film goes into a folder of its own, an episode into the series and season folders. Media libraries expect that. */
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

/** Derive extensions in one place for both library and device downloads. */
export function streamExtension(stream: StreamItem): string {
  const hinted = stream.behaviorHints?.filename;
  const source = hinted ?? (stream.url ? new URL(stream.url).pathname : "");
  return path.extname(source) || ".mp4";
}

/** Browsers cannot preserve server folders, but the basename must match a library download. */
export function deviceFilename(stream: StreamItem, media: MediaInfo | undefined, fallbackTitle: string, settings: DownloadTargetSettings): string {
  const extension = streamExtension(stream);
  const { directory, base } = targetPath(media, fallbackTitle, extension, settings);
  return path.basename(joinTarget(directory, base, extension));
}
