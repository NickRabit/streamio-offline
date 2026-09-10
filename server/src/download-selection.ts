import type { DownloadResolution, DownloadSelection } from "./downloads.js";
import { rankStreams, streamSize } from "./ranking.js";
import type { MediaInfo } from "./probe.js";
import type { StreamItem, SubtitleItem } from "./types.js";

interface Choice {
  stream: StreamItem;
  subtitle?: SubtitleItem;
  resolution: DownloadResolution;
}

interface RankedChoice { choice: Choice; subtitleRank: number }

const normalizedSubtitleLanguage = (subtitle: SubtitleItem) => subtitle.lang?.toLowerCase().split(/[-_]/)[0];

function subtitlesFor(info: MediaInfo, stream: StreamItem, external: SubtitleItem[], selection: DownloadSelection) {
  if (selection.subtitleMode === "off") return { rank: 0 };
  const wanted = [selection.subtitleLanguage, selection.fallbackSubtitleLanguage].filter(Boolean) as string[];
  for (const [rank, language] of wanted.entries()) {
    const embedded = info.subtitleTracks.find((track) => track.language === language);
    if (embedded) return { rank, language, track: embedded.index, source: "embedded" as const };
    const addon = [...(stream.subtitles ?? []), ...external].find((subtitle) => normalizedSubtitleLanguage(subtitle) === language);
    if (addon) return { rank, language, subtitle: addon, source: "addon" as const };
  }
  return { rank: 2 };
}

export async function selectDownloadSource(input: {
  candidates: StreamItem[];
  subtitles: SubtitleItem[];
  selection: DownloadSelection;
  tried: string[];
  inspect: (stream: StreamItem) => Promise<MediaInfo | undefined>;
}): Promise<Choice | undefined> {
  const { selection } = input;
  const priority = new Map(selection.addonKeys.map((key, index) => [key, index]));
  const available = input.candidates.filter((stream) => Boolean(stream.url) && !input.tried.includes(stream.url!));
  const selected = available.filter((stream) => priority.has(stream.addonKey ?? ""));
  const candidates = selection.sourceStrategy === "largest"
    ? [...selected].sort((left, right) => {
      const leftSize = streamSize(left), rightSize = streamSize(right);
      if (leftSize === undefined || rightSize === undefined) {
        if (leftSize !== rightSize) return leftSize === undefined ? 1 : -1;
      } else if (leftSize !== rightSize) return rightSize - leftSize;
      return (priority.get(left.addonKey ?? "") ?? Number.MAX_SAFE_INTEGER)
        - (priority.get(right.addonKey ?? "") ?? Number.MAX_SAFE_INTEGER);
    })
    : selection.addonKeys.flatMap((addonKey) => rankStreams(
      selected.filter((stream) => stream.addonKey === addonKey), selection.audioLanguage, priority));
  let primaryChoice: RankedChoice | undefined;
  let fallbackChoice: RankedChoice | undefined;
  let checkedCandidates = 0;

  for (const stream of candidates) {
    const info = await input.inspect(stream).catch(() => undefined);
    checkedCandidates += 1;
    if (!info?.video || !info.audioTracks.length) continue;
    const primary = info.audioTracks.find((track) => track.language === selection.audioLanguage);
    const secondary = selection.fallbackAudioLanguage
      ? info.audioTracks.find((track) => track.language === selection.fallbackAudioLanguage)
      : undefined;
    const audio = primary ?? secondary;
    if (!audio) continue;

    const subtitle = subtitlesFor(info, stream, input.subtitles, selection);
    if (selection.subtitleMode === "required" && !subtitle.language) continue;
    const choice: Choice = {
      stream,
      subtitle: subtitle.subtitle,
      resolution: {
        checkedCandidates,
        audioLanguage: audio.language,
        audioTrack: audio.index,
        fallbackUsed: !primary,
        subtitleLanguage: subtitle.language,
        subtitleTrack: subtitle.track,
        subtitleSource: subtitle.source,
        subtitleStatus: subtitle.language ? "ready" : selection.subtitleMode === "optional" ? "missing" : undefined,
      },
    };
    const choiceRank = selection.subtitleMode === "required"
      ? subtitle.rank
      : primary || selection.subtitleMode === "off"
        ? 0
        : subtitle.source === "embedded"
          ? subtitle.rank
          : subtitle.language
            ? 2 + subtitle.rank
            : 4;
    if (primary && choiceRank === 0) return choice;
    const previous = primary ? primaryChoice : fallbackChoice;
    if (!previous || choiceRank < previous.subtitleRank) {
      if (primary) primaryChoice = { choice, subtitleRank: choiceRank };
      else fallbackChoice = { choice, subtitleRank: choiceRank };
    }
  }
  const chosen = primaryChoice ?? fallbackChoice;
  if (chosen) chosen.choice.resolution.checkedCandidates = checkedCandidates;
  return chosen?.choice;
}
