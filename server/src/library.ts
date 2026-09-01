import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const VIDEO = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov", ".webm", ".ts", ".m2ts", ".wmv", ".flv", ".mpg", ".mpeg"]);

export interface LibraryEpisode {
  path: string; season: number | null; episode: number | null; title: string; size: number; modified: string;
}
export interface LibraryEntry {
  kind: "movie" | "series"; title: string;
  path?: string; size?: number; modified?: string;
  episodes?: LibraryEpisode[];
}

/** "01 serie", "Season 2", "S03" — složku série píše fronta, ale ručně zkopírované soubory se liší. */
export function parseSeason(folder: string): number | null {
  const match = /^(?:s(?:eason)?\s*)?(\d{1,3})(?:\s*(?:serie|série|season|sezona|sezóna))?$/i.exec(folder.trim())
    ?? /(?:^|\D)s(\d{1,3})(?:\D|$)/i.exec(folder.trim());
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

/** "07 - Název", "S01E07 Název", "7." — číslo dílu je vpředu, zbytek je název. */
export function parseEpisode(filename: string): { episode: number | null; title: string } {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  const tagged = /^s\d{1,3}[\s._-]*e(\d{1,4})[\s._-]*(.*)$/i.exec(base);
  if (tagged) return { episode: Number(tagged[1]), title: tagged[2].trim() || `Epizoda ${Number(tagged[1])}` };
  const numbered = /^(\d{1,4})\s*[-–.)]?\s*(.*)$/.exec(base);
  if (numbered) {
    const episode = Number(numbered[1]);
    return { episode, title: numbered[2].trim() || `Epizoda ${episode}` };
  }
  return { episode: null, title: base };
}

export const isVideo = (filename: string) => VIDEO.has(path.extname(filename).toLowerCase());

/** Cesta nesmí vést mimo adresář se stahováním, ani přes symlink. */
export function resolveInside(root: string, relative: string): string | undefined {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  return target === base || target.startsWith(prefix) ? target : undefined;
}

interface FoundFile { relative: string; size: number; modified: string }

async function walk(root: string, relative = "", depth = 0): Promise<FoundFile[]> {
  if (depth > 4) return [];
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch { return []; }
  const found: FoundFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) { found.push(...await walk(root, next, depth + 1)); continue; }
    if (!entry.isFile() || !isVideo(entry.name)) continue;
    try {
      const info = await stat(path.join(root, next));
      found.push({ relative: next, size: info.size, modified: info.mtime.toISOString() });
    } catch { /* soubor mezitím zmizel */ }
  }
  return found;
}

/** Skládá knihovnu z rozvržení složek, které vytváří fronta: Film/Film.ext a Seriál/01 serie/07 - Díl.ext */
export function buildLibrary(files: FoundFile[]): LibraryEntry[] {
  const series = new Map<string, LibraryEpisode[]>();
  const movies: LibraryEntry[] = [];

  for (const file of files) {
    const parts = file.relative.split(path.sep);
    const filename = parts[parts.length - 1];
    if (parts.length >= 3) {
      const season = parseSeason(parts[parts.length - 2]);
      const { episode, title } = parseEpisode(filename);
      const name = parts[0];
      const list = series.get(name) ?? [];
      list.push({ path: file.relative, season, episode, title, size: file.size, modified: file.modified });
      series.set(name, list);
      continue;
    }
    // Film leží buď přímo v kořeni, nebo ve vlastní složce, podle které se pojmenuje.
    const title = parts.length === 2 ? parts[0] : filename.replace(/\.[^.]+$/, "");
    movies.push({ kind: "movie", title, path: file.relative, size: file.size, modified: file.modified });
  }

  const seriesEntries: LibraryEntry[] = [...series.entries()].map(([title, episodes]) => ({
    kind: "series" as const,
    title,
    episodes: episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0)),
    size: episodes.reduce((sum, item) => sum + item.size, 0),
    modified: episodes.map((item) => item.modified).sort().at(-1),
  }));

  return [...seriesEntries, ...movies].sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
}

export async function scanLibrary(root: string): Promise<LibraryEntry[]> {
  return buildLibrary(await walk(root));
}
