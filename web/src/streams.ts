import { guessLanguages } from "./languages";
import type { Stream } from "./types";

/** Vše, co doplněk o zdroji napsal. Jazyk ani velikost strukturovaně neposílá, bývají tady. */
export const streamText = (stream: Stream) =>
  [stream.name, stream.title, stream.description, stream.behaviorHints?.filename].filter(Boolean).join(" ");

const UNITS: Record<string, number> = { tb: 1e12, gb: 1e9, mb: 1e6, kb: 1e3 };
// Torrentio velikost v behaviorHints neposílá vůbec, má ji jen v textu jako "💾 35.09 GB".
const SIZE = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/i;

export function streamSize(stream: Stream): number | undefined {
  const hinted = stream.behaviorHints?.videoSize;
  if (typeof hinted === "number" && hinted > 0) return hinted;
  const match = SIZE.exec(streamText(stream));
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  const unit = UNITS[match[2].toLowerCase()];
  return Number.isFinite(value) && unit ? Math.round(value * unit) : undefined;
}

export const streamLanguages = (stream: Stream) => guessLanguages(streamText(stream));

export type StreamSort = "recommended" | "size-desc" | "size-asc" | "addon";

export interface StreamFilters { addon: string; language: string; sort: StreamSort }

/** Doporučené = nejdřív preferovaný jazyk, uvnitř skupiny od největšího. */
export function arrangeStreams(streams: Stream[], filters: StreamFilters, preferredLanguage: string, priority: Map<string, number> = new Map()): Stream[] {
  const list = streams.filter((stream) =>
    (!filters.addon || stream.addonName === filters.addon) &&
    (!filters.language || streamLanguages(stream).includes(filters.language)));

  const size = new Map(list.map((stream) => [stream, streamSize(stream)]));
  const decorated = list.map((stream, index) => ({ stream, index }));
  const rank = (stream: Stream) => priority.get(stream.addonName ?? "") ?? Number.MAX_SAFE_INTEGER;
  decorated.sort((a, b) => {
    if (filters.sort === "addon") return (rank(a.stream) - rank(b.stream)) || (a.index - b.index);
    if (filters.sort === "recommended") {
      const preferred = (stream: Stream) => streamLanguages(stream).includes(preferredLanguage) ? 0 : 1;
      const byLanguage = preferred(a.stream) - preferred(b.stream);
      if (byLanguage) return byLanguage;
      const byPriority = rank(a.stream) - rank(b.stream);
      if (byPriority) return byPriority;
    }
    // Neznámá velikost patří na konec při obou směrech řazení, ne jen při sestupném.
    const left = size.get(a.stream), right = size.get(b.stream);
    if (left === undefined || right === undefined) {
      if (left !== right) return left === undefined ? 1 : -1;
    } else if (left !== right) {
      return filters.sort === "size-asc" ? left - right : right - left;
    }
    return a.index - b.index;
  });
  return decorated.map((item) => item.stream);
}
