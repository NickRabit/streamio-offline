import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectLanguage, normalizeLanguage } from "./language.js";

const run = promisify(execFile);

export interface Track {
  /** Index v rámci vlastního typu, tedy N v mapování 0:a:N nebo 0:s:N. */
  index: number;
  codec: string;
  language?: string;
  title?: string;
  channels?: number;
  default?: boolean;
  forced?: boolean;
}

export interface MediaInfo {
  container: string;
  duration?: number;
  video?: { codec: string; width?: number; height?: number };
  audio?: { codec: string; channels?: number };
  audioTracks: Track[];
  subtitleTracks: Track[];
}

interface ProbeStream { codec_type?: string; codec_name?: string; width?: number; height?: number; channels?: number; disposition?: Record<string, number>; tags?: Record<string, string> }

// Obrázkové titulky prohlížeč nezobrazí a do WebVTT je převést nelze.
const BITMAP_SUBTITLES = new Set(["dvd_subtitle", "hdmv_pgs_subtitle", "dvb_subtitle", "xsub"]);

const toTrack = (stream: ProbeStream, index: number): Track => ({
  index,
  codec: stream.codec_name ?? "",
  language: normalizeLanguage(stream.tags?.language) ?? detectLanguage(stream.tags?.title),
  title: stream.tags?.title,
  channels: stream.channels,
  default: stream.disposition?.default === 1,
  forced: stream.disposition?.forced === 1,
});

/** Zjistí skutečné kodeky zdroje. Doplňky posílají nanejvýš nezávazný hint, ffprobe říká pravdu. */
export async function probe(input: string): Promise<MediaInfo | undefined> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-print_format", "json",
      "-analyzeduration", "60M", "-probesize", "100M",
      "-show_format", "-show_streams", input,
    ], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
    const data = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string }; streams?: ProbeStream[] };
    const streams = data.streams ?? [];
    const video = streams.find((item) => item.codec_type === "video" && !item.disposition?.attached_pic);
    const audioTracks = streams.filter((item) => item.codec_type === "audio").map(toTrack);
    const subtitleTracks = streams.filter((item) => item.codec_type === "subtitle").map(toTrack)
      .filter((track) => !BITMAP_SUBTITLES.has(track.codec));
    const audio = streams.find((item) => item.codec_type === "audio");
    const duration = Number(data.format?.duration);
    return {
      container: data.format?.format_name ?? "",
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      video: video?.codec_name ? { codec: video.codec_name, width: video.width, height: video.height } : undefined,
      audio: audio?.codec_name ? { codec: audio.codec_name, channels: audio.channels } : undefined,
      audioTracks, subtitleTracks,
    };
  } catch {
    return undefined;
  }
}
