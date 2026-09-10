import type { DownloadResolution, DownloadSelection } from "./downloads.js";
import { rankStreams } from "./ranking.js";
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
  const candidates = selection.addonKeys.flatMap((addonKey) => rankStreams(
    available.filter((stream) => stream.addonKey === addonKey), selection.audioLanguage, priority));
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
    if (primary && subtitle.rank === 0) return choice;
    const previous = primary ? primaryChoice : fallbackChoice;
    if (!previous || subtitle.rank < previous.subtitleRank) {
      if (primary) primaryChoice = { choice, subtitleRank: subtitle.rank };
      else fallbackChoice = { choice, subtitleRank: subtitle.rank };
    }
  }
  const chosen = primaryChoice ?? fallbackChoice;
  if (chosen) chosen.choice.resolution.checkedCandidates = checkedCandidates;
  return chosen?.choice;
}
