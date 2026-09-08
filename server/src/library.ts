import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const VIDEO = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov", ".webm", ".ts", ".m2ts", ".wmv", ".flv", ".mpg", ".mpeg"]);

export interface LibraryFile {
  path: string; label: string; season: number | null; episode: number | null; size: number; modified: string;
}

/** The overview without files. A folder may hold thousands of items, so the list is fetched separately. */
export type LibraryKind = "movie" | "series" | "collection";

export interface LibrarySummary {
  key: string; kind: LibraryKind; title: string;
  fileCount: number; size: number; modified: string;
  /** The thumbnail address, when there is one. The client does not care whether it sits next to the video or in the data directory. */
  poster?: string;
  meta?: { type: string; id: string; name?: string; poster?: string; background?: string; description?: string; year?: string };
}

export interface LibraryEntry {
  /** The folder the item came from. Stable even after the title is renamed from metadata. */
  key: string;
  kind: LibraryKind;
  title: string;
  files: LibraryFile[];
  poster?: string;
  size: number;
  modified: string;
  meta?: { type: string; id: string; name?: string; poster?: string; background?: string; description?: string; year?: string };
}

/** "01 serie", "Season 2", "S03" -- the queue writes the season folder, but hand-copied files differ. */
export function parseSeason(folder: string): number | null {
  const match = /^(?:s(?:eason)?|serie|série|series|sezona|sezóna)?[\s._-]*(\d{1,3})(?:\s*(?:serie|série|season|sezona|sezóna))?$/i.exec(folder.trim())
    ?? /(?:^|\D)s(\d{1,3})(?:\D|$)/i.exec(folder.trim());
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

/** "07 - Name", "S01E07 Name", "7." -- the episode number comes first, the rest is the name. */
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

const TAGGED_EPISODE = /\bs(\d{1,3})[\s._-]*e(\d{1,4})\b/i;
const CROSS_EPISODE = /\b(\d{1,2})x(\d{1,3})\b/i;

/** Season and episode of a video file: "S01E02" or "1x02" in its own name first,
 *  then a plain leading number inside a season folder. */
export function numberedEpisode(relative: string): { season: number; episode: number } | undefined {
  const base = path.basename(relative);
  if (!isVideo(base)) return undefined;
  const name = base.replace(/\.[^.]+$/, "");
  const tagged = TAGGED_EPISODE.exec(name) ?? CROSS_EPISODE.exec(name);
  if (tagged) return { season: Number(tagged[1]), episode: Number(tagged[2]) };
  const folder = path.dirname(relative);
  const season = folder && folder !== "." ? parseSeason(path.basename(folder)) : null;
  const { episode } = parseEpisode(base);
  if (season != null && episode != null) return { season, episode };
  return undefined;
}

export const isVideo = (filename: string) => VIDEO.has(path.extname(filename).toLowerCase());

/** The path must not lead outside the download directory, not even through a symlink. */
export function resolveInside(root: string, relative: string): string | undefined {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  return target === base || target.startsWith(prefix) ? target : undefined;
}

/** Rewrites the path of the item itself and of everything under it. */
export function remapPath(value: string, from: string, to: string): string {
  return value === from || value.startsWith(`${from}${path.sep}`) ? to + value.slice(from.length) : value;
}

export function isPathWithin(value: string, parent: string): boolean {
  return value === parent || value.startsWith(`${parent}${path.sep}`);
}

/** Catalogue titles nothing in the library points at once the path is deleted.
 * What another path still holds -- a series split across two folders, say -- stays:
 * deleting one of them does not mean the title left the library. */
export function orphanedCatalogKeys(meta: Record<string, { type: string; id: string }>, relative: string): Set<string> {
  const removed = new Set<string>(); const kept = new Set<string>();
  for (const [key, value] of Object.entries(meta)) {
    if (!value.id) continue;
    (isPathWithin(key, relative) ? removed : kept).add(`${value.type}:${value.id}`);
  }
  for (const key of kept) removed.delete(key);
  return removed;
}

export interface FoundFile { relative: string; size: number; modified: string }

/** Every video under root, same walk `scanLibrary` uses. Depth cap 8, skip dotfiles. */
export async function listVideos(root: string, relative = "", depth = 0): Promise<FoundFile[]> {
  // The structure is the user's own: downloads/series/Show/01 serie/episode.mkv and deeper.
  if (depth > 8) return [];
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch { return []; }
  const found: FoundFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) { found.push(...await listVideos(root, next, depth + 1)); continue; }
    if (!entry.isFile() || !isVideo(entry.name)) continue;
    try {
      const info = await stat(path.join(root, next));
      found.push({ relative: next, size: info.size, modified: info.mtime.toISOString() });
    } catch { /* the file disappeared meanwhile */ }
  }
  return found;
}

/** One folder is one title. Several files in it are versions or episodes of the same thing, not separate items. */
export function buildLibrary(files: FoundFile[]): LibraryEntry[] {
  const groups = new Map<string, FoundFile[]>();
  for (const file of files) {
    const parts = file.relative.split(path.sep);
    // A file sitting in the root has no folder and stands for itself.
    const key = parts.length === 1 ? file.relative : parts[0];
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(file);
  }

  const entries: LibraryEntry[] = [...groups.entries()].map(([key, group]) => {
    const inSeason = group.some((file) => file.relative.split(path.sep).length >= 3);
    const items: LibraryFile[] = group.map((file) => {
      const parts = file.relative.split(path.sep);
      const filename = parts[parts.length - 1];
      const season = parts.length >= 3 ? parseSeason(parts[parts.length - 2]) : null;
      const { episode, title } = parseEpisode(filename);
      return {
        path: file.relative,
        label: inSeason ? title : filename.replace(/\.[^.]+$/, ""),
        season, episode, size: file.size, modified: file.modified,
      };
    }).sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.label.localeCompare(b.label, "cs"));

    return {
      key,
      // One film, a series with seasons, or a folder with a pile of files to browse.
      kind: inSeason ? "series" : items.length > 1 ? "collection" : "movie",
      title: key.replace(/\.[^.]+$/, ""),
      files: items,
      size: items.reduce((sum, item) => sum + item.size, 0),
      modified: items.map((item) => item.modified).sort().at(-1) ?? "",
    };
  });

  return entries.sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function scanLibrary(root: string): Promise<LibraryEntry[]> {
  return buildLibrary(await listVideos(root));
}

export const summarize = ({ files, ...entry }: LibraryEntry): LibrarySummary => ({ ...entry, fileCount: files.length });

/** The item's folder relative to the download root. A file in the root has no folder of its own. */
export const entryDirectory = (entry: { key: string; files: { path: string }[] }) =>
  entry.files[0]?.path.includes(path.sep) ? entry.key : "";

/** A slice of one item's files, optionally filtered by name. */
export function pageFiles(entry: LibraryEntry, query: string, skip: number, limit: number) {
  const needle = query.trim().toLowerCase();
  const matching = needle ? entry.files.filter((file) => file.label.toLowerCase().includes(needle)) : entry.files;
  return { files: matching.slice(skip, skip + limit), total: matching.length };
}

export type LibrarySort = "name" | "added" | "size" | "random";

/** A random order has to stay the same across pages, or items would repeat.
 *  The client therefore sends a seed and the order derives from it rather than being truly random. */
const seededKey = (value: string, seed: string) => {
  let hash = 2166136261;
  for (const char of `${seed}:${value}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};

export function sortFiles<T extends { label: string; size: number; modified: string; path: string; season?: number | null; episode?: number | null }>(
  files: T[], sort: LibrarySort, descending: boolean, seed = "",
): T[] {
  const list = [...files];
  const dir = descending ? -1 : 1;
  if (sort === "random") return list.sort((a, b) => seededKey(a.path, seed) - seededKey(b.path, seed));
  list.sort((a, b) => {
    if (sort === "added") return (a.modified.localeCompare(b.modified)) * dir;
    if (sort === "size") return (a.size - b.size) * dir;
    // The default order keeps episodes of a series together, otherwise it sorts by name.
    return ((a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.label.localeCompare(b.label, "cs")) * dir;
  });
  return list;
}

/** Describes one path as a list item. Used for the virtual favourites folder, whose items
 *  come from all over the tree. */
export async function describePath(root: string, relative: string): Promise<BrowseItem | undefined> {
  const target = resolveInside(root, relative);
  if (!target) return undefined;
  const info = await stat(target).catch(() => undefined);
  if (!info) return undefined;
  const name = path.basename(relative);
  if (info.isDirectory()) {
    const inside = await listVideos(root, relative);
    if (!inside.length) return undefined;
    return {
      kind: "folder", path: relative, name, fileCount: inside.length,
      size: inside.reduce((sum, file) => sum + file.size, 0),
      modified: inside.map((file) => file.modified).sort().at(-1) ?? info.mtime.toISOString(),
    };
  }
  if (!isVideo(name)) return undefined;
  const { episode, title } = parseEpisode(name);
  return {
    kind: "file", path: relative, label: title || name.replace(/\.[^.]+$/, ""),
    season: parseSeason(path.basename(path.dirname(relative))), episode,
    size: info.size, modified: info.mtime.toISOString(),
  };
}

export type LibraryMatch = "unmatched" | "matched" | "suggested" | "rejected";
export interface BrowseFolder { path: string; name: string; fileCount: number; size: number; modified: string }
export type BrowseMeta = { year?: string; description?: string; catalogName?: string; match?: LibraryMatch; skipLookup?: boolean };
export type BrowseItem =
  | ({ kind: "folder"; favorite?: boolean } & BrowseFolder & BrowseMeta)
  | ({ kind: "file"; favorite?: boolean } & LibraryFile & BrowseMeta);
/** One sorted list. Two arrays would split that order back into groups when rendered. */
export interface BrowseResult { path: string; items: BrowseItem[]; total: number }

/** The contents of one folder: its subfolders and videos. It does not descend; that is what opening a folder is for. */
export async function browseDirectory(root: string, relative: string, query = "", skip = 0, limit = 60,
  sort: LibrarySort = "name", descending = false, seed = "", onlyPaths?: ReadonlySet<string>): Promise<BrowseResult> {
  const target = resolveInside(root, relative);
  if (!target) return { path: relative, items: [], total: 0 };
  let entries;
  try { entries = await readdir(target, { withFileTypes: true }); } catch { return { path: relative, items: [], total: 0 }; }

  const needle = query.trim().toLowerCase();
  const folders: BrowseFolder[] = [];
  const files: LibraryFile[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const inside = await listVideos(root, childRelative);
      if (!inside.length) continue;
      if (needle && !entry.name.toLowerCase().includes(needle)) continue;
      folders.push({
        path: childRelative, name: entry.name, fileCount: inside.length,
        size: inside.reduce((sum, f) => sum + f.size, 0),
        modified: inside.map((f) => f.modified).sort().at(-1) ?? "",
      });
      continue;
    }
    if (!entry.isFile() || !isVideo(entry.name)) continue;
    const label = entry.name.replace(/\.[^.]+$/, "");
    if (needle && !label.toLowerCase().includes(needle)) continue;
    try {
      const info = await stat(path.join(root, childRelative));
      const numbers = numberedEpisode(childRelative);
      files.push({
        path: childRelative, label,
        season: numbers?.season ?? null, episode: numbers?.episode ?? null,
        size: info.size, modified: info.mtime.toISOString(),
      });
    } catch { /* it disappeared in the meantime */ }
  }

  // Folders and files are sorted as one list. Taken separately, sorting by date or size
  // would produce two independent runs one after the other.
  type Mixed = {
    path: string; label: string; size: number; modified: string;
    season?: number | null; episode?: number | null; folder?: BrowseFolder; file?: LibraryFile;
  };
  const mixed: Mixed[] = [
    ...folders.map((folder) => ({ path: folder.path, label: folder.name, size: folder.size, modified: folder.modified, folder })),
    ...files.map((file) => ({ path: file.path, label: file.label, size: file.size, modified: file.modified, season: file.season, episode: file.episode, file })),
  ];
  // The filter has to run before paging. Otherwise a favourite on the second page would
  // never be seen and the total would be wrong.
  const ordered = sortFiles(mixed, sort, descending, seed)
    .filter((item) => !onlyPaths || onlyPaths.has(item.path));
  const page = ordered.slice(skip, skip + limit);
  return {
    path: relative,
    items: page.map((item) => item.folder
      ? { kind: "folder" as const, ...item.folder }
      : { kind: "file" as const, ...item.file! }),
    total: ordered.length,
  };
}
