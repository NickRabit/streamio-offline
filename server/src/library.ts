import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const VIDEO = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov", ".webm", ".ts", ".m2ts", ".wmv", ".flv", ".mpg", ".mpeg"]);

export interface LibraryFile {
  path: string; label: string; season: number | null; episode: number | null; size: number; modified: string;
}

/** Přehled bez souborů. Složka může mít tisíce položek, seznam se proto dotahuje zvlášť. */
export type LibraryKind = "movie" | "series" | "collection";

export interface LibrarySummary {
  key: string; kind: LibraryKind; title: string;
  fileCount: number; size: number; modified: string;
  /** Adresa náhledu, když existuje. Klient neřeší, jestli leží u videa nebo v datech. */
  poster?: string;
  meta?: { type: string; id: string; name?: string; poster?: string; background?: string; description?: string; year?: string };
}

export interface LibraryEntry {
  /** Složka, ze které položka vznikla. Stabilní i po přejmenování titulu z metadat. */
  key: string;
  kind: LibraryKind;
  title: string;
  files: LibraryFile[];
  poster?: string;
  size: number;
  modified: string;
  meta?: { type: string; id: string; name?: string; poster?: string; background?: string; description?: string; year?: string };
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
  // Struktura je na uživateli: downloads/serialy/Seriál/01 serie/díl.mkv i hlubší.
  if (depth > 8) return [];
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

/** Jedna složka je jeden titul. Víc souborů v ní jsou verze nebo díly téhož, ne samostatné položky. */
export function buildLibrary(files: FoundFile[]): LibraryEntry[] {
  const groups = new Map<string, FoundFile[]>();
  for (const file of files) {
    const parts = file.relative.split(path.sep);
    // Soubor ležící rovnou v kořeni nemá složku, zastupuje sám sebe.
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
      // Jeden film, seriál se sezónami, nebo složka s hromadou souborů k procházení.
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
  return buildLibrary(await walk(root));
}

export const summarize = ({ files, ...entry }: LibraryEntry): LibrarySummary => ({ ...entry, fileCount: files.length });

/** Složka položky vůči kořeni stahování. Soubor v kořeni vlastní složku nemá. */
export const entryDirectory = (entry: { key: string; files: { path: string }[] }) =>
  entry.files[0]?.path.includes(path.sep) ? entry.key : "";

/** Výřez souborů jedné položky, volitelně filtrovaný podle názvu. */
export function pageFiles(entry: LibraryEntry, query: string, skip: number, limit: number) {
  const needle = query.trim().toLowerCase();
  const matching = needle ? entry.files.filter((file) => file.label.toLowerCase().includes(needle)) : entry.files;
  return { files: matching.slice(skip, skip + limit), total: matching.length };
}

export type LibrarySort = "name" | "added" | "size" | "random";

/** Náhodné pořadí musí být mezi stránkami stejné, jinak by se položky opakovaly.
 *  Klient proto posílá semínko a řazení je z něj odvozené, ne skutečně náhodné. */
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
    // Výchozí pořadí drží díly seriálu pohromadě, jinak řadí podle názvu.
    return ((a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.label.localeCompare(b.label, "cs")) * dir;
  });
  return list;
}

/** Popíše jednu cestu jako položku seznamu. Používá se pro virtuální složku oblíbených,
 *  kde položky pocházejí z různých míst stromu. */
export async function describePath(root: string, relative: string): Promise<BrowseItem | undefined> {
  const target = resolveInside(root, relative);
  if (!target) return undefined;
  const info = await stat(target).catch(() => undefined);
  if (!info) return undefined;
  const name = path.basename(relative);
  if (info.isDirectory()) {
    const inside = await walk(root, relative);
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

export interface BrowseFolder { path: string; name: string; fileCount: number; size: number; modified: string }
export type BrowseItem =
  | ({ kind: "folder"; favorite?: boolean } & BrowseFolder)
  | ({ kind: "file"; favorite?: boolean } & LibraryFile);
/** Jeden seřazený seznam. Dvě pole by při vykreslení pořadí zase rozdělila na skupiny. */
export interface BrowseResult { path: string; items: BrowseItem[]; total: number }

/** Obsah jedné složky: podsložky a videa v ní. Do hloubky se nesestupuje, od toho je proklik. */
export async function browseDirectory(root: string, relative: string, query = "", skip = 0, limit = 60,
  sort: LibrarySort = "name", descending = false, seed = ""): Promise<BrowseResult> {
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
      const inside = await walk(root, childRelative);
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
      const season = parseSeason(path.basename(relative));
      const { episode } = parseEpisode(entry.name);
      files.push({ path: childRelative, label, season, episode: season != null ? episode : null, size: info.size, modified: info.mtime.toISOString() });
    } catch { /* zmizelo mezitím */ }
  }

  // Složky a soubory se řadí jako jeden seznam. Kdyby se braly zvlášť, vznikly by
  // při řazení podle data nebo velikosti dvě nezávislé řady za sebou.
  type Mixed = {
    path: string; label: string; size: number; modified: string;
    season?: number | null; episode?: number | null; folder?: BrowseFolder; file?: LibraryFile;
  };
  const mixed: Mixed[] = [
    ...folders.map((folder) => ({ path: folder.path, label: folder.name, size: folder.size, modified: folder.modified, folder })),
    ...files.map((file) => ({ path: file.path, label: file.label, size: file.size, modified: file.modified, season: file.season, episode: file.episode, file })),
  ];
  const page = sortFiles(mixed, sort, descending, seed).slice(skip, skip + limit);
  return {
    path: relative,
    items: page.map((item) => item.folder
      ? { kind: "folder" as const, ...item.folder }
      : { kind: "file" as const, ...item.file! }),
    total: mixed.length,
  };
}

