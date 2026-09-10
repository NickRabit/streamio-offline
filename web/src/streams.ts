import { guessLanguages } from "./languages";
import type { Stream } from "./types";

/** Everything the addon wrote about the source. It sends neither language nor size as data; they tend to be in here. */
export const streamText = (stream: Stream) =>
  [stream.name, stream.title, stream.description, stream.behaviorHints?.filename].filter(Boolean).join(" ");

const UNITS: Record<string, number> = { tb: 1e12, gb: 1e9, mb: 1e6, kb: 1e3 };
// Torrentio does not send the size in behaviorHints at all, only in the text as "💾 35.09 GB".
const SIZE = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|KB)\b/gi;

export function streamSize(stream: Stream): number | undefined {
  const hinted = stream.behaviorHints?.videoSize;
  if (typeof hinted === "number" && hinted > 0) return hinted;
  const matches = [...streamText(stream).matchAll(SIZE)];
  const match = matches[matches.length - 1];
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  const unit = UNITS[match[2].toLowerCase()];
  return Number.isFinite(value) && unit ? Math.round(value * unit) : undefined;
}

export const streamLanguages = (stream: Stream) => guessLanguages(streamText(stream));

export type StreamSort = "recommended" | "size-desc" | "size-asc" | "addon";

export interface StreamFilters { addon: string; language: string; sort: StreamSort }

/** Recommended = the preferred language first, largest first within the group. */
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
    // An unknown size belongs at the end in both sort directions, not only in descending order.
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

export function visibleCatalogStreams(
  streams: Stream[],
  filters: StreamFilters,
  preferredLanguage: string,
  priority: Map<string, number>,
  showTorrents: boolean,
): Stream[] {
  const arranged = arrangeStreams(streams, filters, preferredLanguage, priority);
  return showTorrents ? arranged : arranged.filter((stream) => stream.kind !== "torrent");
}

export function pickDefaultStream(streams: Stream[]): Stream | undefined {
  return streams.find((stream) => stream.playable) ?? streams[0];
}

export function streamBadge(stream: Stream): string {
  if (stream.playable) return "HTTP";
  if (stream.kind === "torrent") return "RD";
  return "EXT";
}

export function canQueue(stream: Stream, debridConfigured: boolean): boolean {
  return stream.playable || (stream.kind === "torrent" && debridConfigured);
}
