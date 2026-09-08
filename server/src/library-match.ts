import path from "node:path";
import { isPathWithin, isVideo, parseSeason, remapPath, type FoundFile } from "./library.js";
import { parseMediaPath, type ParsedMedia } from "./library-parse.js";
import type { MetaItem } from "./types.js";

export type TitleKind = "movie" | "series";

export interface TitleUnit {
  key: string;
  kind: TitleKind;
  relative: string;
  sampleFiles: string[];
}

export interface ScoredHit {
  item: MetaItem;
  score: number;
  titleSimilarity: number;
  yearDelta?: number;
  autoEligible: boolean;
}

export interface LibrarySuggestion {
  type: string;
  id: string;
  name: string;
  year?: number;
  score: number;
}

export interface LibraryMetaRecord {
  type: string;
  id: string;
  source?: "download" | "user" | "scan";
  locked?: boolean;
  name?: string;
  year?: string;
  description?: string;
  matchedAt?: string;
}

export interface ViewedMeta {
  type: string;
  id: string;
  source: "download" | "user" | "scan";
  locked: boolean;
}

const EXTRA_TOKENS = new Set(["trailer", "sample", "extra", "bonus"]);
const ARTICLES = /^(the|a|an)\s+/;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const cur = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    cur[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j < cols; j += 1) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

export function normalizeTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(ARTICLES, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(value: string): Set<string> {
  return new Set(normalizeTitle(value).split(" ").filter(Boolean));
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

export function yearFromMeta(item: MetaItem): number | undefined {
  const raw = String(item.releaseInfo ?? item.year ?? "").slice(0, 4);
  if (!/^(19|20)\d{2}$/.test(raw)) return undefined;
  return Number(raw);
}

export function scoreHit(parsed: ParsedMedia, item: MetaItem, expectedKind?: TitleKind): ScoredHit {
  const left = normalizeTitle(parsed.query || parsed.title);
  const right = normalizeTitle(item.name);
  const maxLen = Math.max(left.length, right.length);
  const edit = maxLen === 0 ? 1 : 1 - levenshtein(left, right) / maxLen;
  const titleSimilarity = 0.7 * dice(tokensOf(left), tokensOf(right)) + 0.3 * edit;
  let score = 100 - Math.round((1 - titleSimilarity) * 50);
  let autoEligible = true;
  const parsedYear = parsed.year;
  const itemYear = yearFromMeta(item);
  let yearDelta: number | undefined;
  if (parsedYear != null && itemYear != null) {
    yearDelta = Math.abs(parsedYear - itemYear);
    if (yearDelta === 0) { /* no penalty */ }
    else if (yearDelta === 1) score -= 10;
    else if (yearDelta === 2) score -= 20;
    else {
      score -= 40;
      autoEligible = false;
    }
  }
  if (expectedKind && item.type && item.type !== expectedKind) {
    score -= 25;
    autoEligible = false;
  }
  score = Math.max(0, Math.min(100, score));
  return { item, score, titleSimilarity, yearDelta, autoEligible };
}

export function autoAccept(hits: ScoredHit[], nowYear = new Date().getFullYear()): ScoredHit | undefined {
  const ranked = hits.filter((hit) => hit.autoEligible).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (yearFromMeta(b.item) ?? 0) - (yearFromMeta(a.item) ?? 0);
  });
  const top = ranked[0];
  if (!top || top.score < 85 || top.titleSimilarity < 0.90) return undefined;
  const close = ranked.filter((hit) => top.score - hit.score < 15 && hit.titleSimilarity >= 0.90);
  const topName = normalizeTitle(top.item.name);
  if (close.some((hit) => normalizeTitle(hit.item.name) !== topName)) return undefined;
  const years = close.map((hit) => yearFromMeta(hit.item)).filter((year): year is number => year != null);
  const distinct = new Set(years);
  if (distinct.size <= 1) return top;
  return Math.max(...years) >= nowYear - 2 ? top : undefined;
}

export function pickSuggestion(hits: ScoredHit[]): LibrarySuggestion | undefined {
  const top = [...hits].sort((a, b) => b.score - a.score)[0];
  if (!top) return undefined;
  const year = yearFromMeta(top.item);
  return {
    type: top.item.type,
    id: top.item.id,
    name: top.item.name,
    score: top.score,
    ...(year != null ? { year } : {}),
  };
}

export function viewMeta(raw?: LibraryMetaRecord): ViewedMeta | undefined {
  if (!raw) return undefined;
  const source = raw.source ?? "download";
  const locked = raw.locked ?? (source === "download" || source === "user");
  return { type: raw.type, id: raw.id, source, locked };
}

/** Why the scanner should skip this key. Bound and locked both skip. */
export function scanSkipReason(raw?: LibraryMetaRecord): "bound" | "locked" | undefined {
  const viewed = viewMeta(raw);
  if (!viewed) return undefined;
  if (viewed.locked) return "locked";
  if (viewed.id) return "bound";
  return undefined;
}

export type MatchStatus = "unmatched" | "matched" | "suggested" | "rejected";

const DESCRIPTION_MAX = 180;

export function knownTitleOf(relative: string, records: Record<string, LibraryMetaRecord>): LibraryMetaRecord | undefined {
  const parts = relative.split(path.sep);
  let found = records[relative];
  for (let depth = parts.length - 1; !found && depth > 0; depth -= 1) found = records[parts.slice(0, depth).join(path.sep)];
  if (!found || !viewMeta(found)?.id) return undefined;
  return found;
}

export function matchStatus(
  relative: string,
  records: Record<string, LibraryMetaRecord>,
  suggestions: Record<string, LibrarySuggestion> = {},
): MatchStatus {
  const exact = viewMeta(records[relative]);
  if (exact?.locked && !exact.id) return "rejected";
  if (knownTitleOf(relative, records)?.id) return "matched";
  const parts = relative.split(path.sep);
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    const key = parts.slice(0, depth).join(path.sep);
    if (suggestions[key]) return "suggested";
  }
  return "unmatched";
}

export function cacheFieldsFromMeta(meta: MetaItem | null | undefined): { name?: string; year?: string; description?: string } {
  if (!meta) return {};
  const year = yearFromMeta(meta);
  const description = typeof meta.description === "string" ? meta.description.slice(0, DESCRIPTION_MAX) : undefined;
  return {
    ...(meta.name ? { name: meta.name } : {}),
    ...(year != null ? { year: String(year) } : {}),
    ...(description ? { description } : {}),
  };
}

export function needsBackfill(raw?: LibraryMetaRecord): boolean {
  const viewed = viewMeta(raw);
  if (!viewed?.id) return false;
  if (!raw?.name) return true;
  return raw.year == null && raw.description == null;
}

export function browseMeta(
  relative: string,
  label: string,
  records: Record<string, LibraryMetaRecord>,
  suggestions: Record<string, LibrarySuggestion> = {},
): { match: MatchStatus; year?: string; description?: string; catalogName?: string } {
  const match = matchStatus(relative, records, suggestions);
  if (match !== "matched") return { match };
  const known = knownTitleOf(relative, records);
  if (!known) return { match };
  const catalogName = known.name && normalizeTitle(known.name) !== normalizeTitle(label) ? known.name : undefined;
  return {
    match,
    ...(known.year ? { year: known.year } : {}),
    ...(known.description ? { description: known.description } : {}),
    ...(catalogName ? { catalogName } : {}),
  };
}

export function remapKeyed<T>(records: Record<string, T>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(records).map(([key, value]) => [remapPath(key, from, to), value]));
}

export function dropKeyed<T>(records: Record<string, T>, relative: string): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([key]) => !isPathWithin(key, relative)));
}

function parentOf(relative: string): string {
  const index = relative.lastIndexOf(path.sep);
  return index < 0 ? "" : relative.slice(0, index);
}

function isTaggedEpisode(filename: string): boolean {
  return /s\d{1,3}[\s._-]*e\d{1,4}/i.test(filename);
}

export function isExtraName(filename: string): boolean {
  const title = parseMediaPath(filename).title.toLowerCase();
  return title.split(/[\s-]+/).filter(Boolean).some((token) => EXTRA_TOKENS.has(token));
}

function comparableTitle(filename: string): string {
  return normalizeTitle(parseMediaPath(filename).title).replace(/\s+\d+$/, "").trim();
}

interface DirIndex {
  videos: Map<string, FoundFile[]>;
  children: Map<string, Set<string>>;
  all: FoundFile[];
}

function indexFiles(files: FoundFile[]): DirIndex {
  const videos = new Map<string, FoundFile[]>();
  const children = new Map<string, Set<string>>();
  const addChild = (parent: string, child: string) => {
    const set = children.get(parent) ?? new Set<string>();
    set.add(child);
    children.set(parent, set);
  };
  for (const file of files) {
    const parts = file.relative.split(path.sep);
    let acc = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = acc ? `${acc}${path.sep}${parts[i]}` : parts[i]!;
      addChild(acc, dir);
      acc = dir;
    }
    const parent = parentOf(file.relative);
    const list = videos.get(parent) ?? [];
    list.push(file);
    videos.set(parent, list);
  }
  return { videos, children, all: files };
}

function filesUnder(index: DirIndex, dir: string): string[] {
  if (!dir) return index.all.map((file) => file.relative);
  const prefix = `${dir}${path.sep}`;
  return index.all.filter((file) => file.relative.startsWith(prefix)).map((file) => file.relative);
}

function uniqueNonExtraTitles(videos: FoundFile[]): Set<string> {
  const titles = new Set<string>();
  for (const file of videos) {
    if (isExtraName(path.basename(file.relative))) continue;
    const title = comparableTitle(path.basename(file.relative));
    if (title) titles.add(title);
  }
  return titles;
}

function isCollection(index: DirIndex, dir: string): boolean {
  return uniqueNonExtraTitles(index.videos.get(dir) ?? []).size >= 2;
}

function emit(out: TitleUnit[], key: string, kind: TitleKind, samples: string[]) {
  out.push({ key, kind, relative: key, sampleFiles: samples });
}

function classifyVideosOnly(index: DirIndex, dir: string, videos: FoundFile[], out: TitleUnit[]) {
  const nonExtra = videos.filter((file) => !isExtraName(path.basename(file.relative)));
  if (!nonExtra.length) return;
  const tagged = videos.filter((file) => isTaggedEpisode(path.basename(file.relative)));
  if (tagged.length * 2 > videos.length) {
    emit(out, dir, "series", videos.map((file) => file.relative));
    return;
  }
  if (nonExtra.length === 1 || uniqueNonExtraTitles(videos).size === 1) {
    emit(out, dir, "movie", videos.map((file) => file.relative));
  }
}

function classifyFolder(index: DirIndex, dir: string, out: TitleUnit[]) {
  const videos = index.videos.get(dir) ?? [];
  const children = [...(index.children.get(dir) ?? [])];
  if (children.some((child) => parseSeason(path.basename(child)) != null)) {
    emit(out, dir, "series", filesUnder(index, dir));
    return;
  }
  if (isCollection(index, dir)) return;
  if (children.length) {
    walkContainer(index, dir, out);
    return;
  }
  classifyVideosOnly(index, dir, videos, out);
}

function walkContainer(index: DirIndex, dir: string, out: TitleUnit[]) {
  for (const video of index.videos.get(dir) ?? []) {
    emit(out, video.relative, "movie", [video.relative]);
  }
  for (const child of index.children.get(dir) ?? []) classifyFolder(index, child, out);
}

export function titleUnits(files: FoundFile[]): TitleUnit[] {
  const out: TitleUnit[] = [];
  walkContainer(indexFiles(files), "", out);
  return out;
}

export function matchKeyFor(relative: string, files: FoundFile[]): string {
  const units = titleUnits(files);
  const covering = units.filter((unit) => relative === unit.key || isPathWithin(relative, unit.key));
  if (covering.length) return covering.sort((a, b) => b.key.length - a.key.length)[0]!.key;

  if (isVideo(relative)) {
    const parent = parentOf(relative);
    if (!parent) return relative;
    const siblings = files.filter((file) => parentOf(file.relative) === parent);
    const nested = files.filter((file) => file.relative.startsWith(`${parent}${path.sep}`) && parentOf(file.relative) !== parent);
    if (nested.length) {
      const sameFolder = files.filter((file) => parentOf(file.relative) === parent);
      if (sameFolder.length === 1 || uniqueNonExtraTitles(sameFolder).size <= 1) return parent;
      return relative;
    }
    if (isCollection({ videos: new Map([[parent, siblings]]), children: new Map(), all: siblings }, parent)) return relative;
    if (siblings.length) return parent;
    return relative;
  }
  return relative;
}
