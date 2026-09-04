import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { AudioLines, Captions, CaptionsOff, Check, Download, HardDrive, Star, Gauge, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, SlidersHorizontal, Volume2, X } from "lucide-react";
import { ApiError, api, subtitleUrl } from "./api";
import { label } from "./languages";
import { hostOf, report } from "./diagnostics";
import { AHEAD_CATCHUP_MS, HLS_PLAYER_CONFIG, ignoreHlsErrorDuringRestart, planSeek, waitForSeekable } from "./player-hls";
import type { Capabilities, PlaybackMode, PlaybackSession, Stream, Subtitle, Track } from "./types";

interface Props { open: boolean; title: string; stream: Stream | null; subtitles: Subtitle[]; subtitleLanguage: string; progressKey?: string; progressPoster?: string; favorite?: boolean; onToggleFavorite?: () => void; onDownload: () => Promise<boolean>; onDeviceDownload: () => Promise<boolean>; onClose: () => void }

const fmt = (seconds: number) => !Number.isFinite(seconds) ? "0:00" : `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ""}${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Native range thumbs are the only draggable part on iOS. A press anywhere on
 *  the track grabs the current position; the finger then nudges it by how far
 *  it moves, instead of jumping to the press point. A tap still seeks there. */
const TAP_PX = 10;

const timeAtClientX = (clientX: number, track: HTMLElement, max: number) => {
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0 || max <= 0) return 0;
  return Math.min(max, Math.max(0, ((clientX - rect.left) / rect.width) * max));
};

const timeFromDelta = (clientX: number, track: HTMLElement, startX: number, startValue: number, max: number) => {
  const width = track.getBoundingClientRect().width;
  if (width <= 0 || max <= 0) return startValue;
  return Math.min(max, Math.max(0, startValue + ((clientX - startX) / width) * max));
};

function TimelineBar({ value, max, onScrub, onSeek, onReveal }: {
  value: number; max: number; onScrub: (value: number | null) => void; onSeek: (value: number) => void; onReveal: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const maxRef = useRef(max);
  const valueRef = useRef(value);
  const onScrubRef = useRef(onScrub);
  const onSeekRef = useRef(onSeek);
  const onRevealRef = useRef(onReveal);
  maxRef.current = max;
  valueRef.current = value;
  onScrubRef.current = onScrub;
  onSeekRef.current = onSeek;
  onRevealRef.current = onReveal;

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const track = trackRef.current;
      if (!track) return;
      event.preventDefault();
      onRevealRef.current();
      if (!drag.moved && Math.abs(event.clientX - drag.startX) < TAP_PX) return;
      drag.moved = true;
      onScrubRef.current(timeFromDelta(event.clientX, track, drag.startX, drag.startValue, maxRef.current));
    };
    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const track = trackRef.current;
      dragRef.current = null;
      setDragging(false);
      if (!track) { onScrubRef.current(null); return; }
      if (event.type === "pointercancel") { onScrubRef.current(null); return; }
      if (drag.moved) onSeekRef.current(timeFromDelta(event.clientX, track, drag.startX, drag.startValue, maxRef.current));
      else onSeekRef.current(timeAtClientX(event.clientX, track, maxRef.current));
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return <div
    ref={trackRef}
    className={`timeline-bar${dragging ? " scrubbing" : ""}`}
    role="slider"
    tabIndex={0}
    aria-label="Pozice videa"
    aria-valuemin={0}
    aria-valuemax={Math.round(max)}
    aria-valuenow={Math.round(Math.min(value, max))}
    aria-valuetext={fmt(value)}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: valueRef.current, moved: false };
      setDragging(true);
      onReveal();
      onScrub(valueRef.current);
    }}>
    <div className="timeline-rail" aria-hidden="true">
      <i className="timeline-fill" style={{ width: `${percent}%` }} />
      <b className="timeline-thumb" style={{ left: `${percent}%` }} />
    </div>
    {dragging && <span className="timeline-preview" style={{ left: `${percent}%` }}>{fmt(value)}</span>}
  </div>;
}

/** Prohlížeč sám nejlépe ví, co zvládne. Server podle toho rozhodne, co kopírovat a co překódovat. */
const supports = (type: string) => {
  try { if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported) return MediaSource.isTypeSupported(type); } catch { /* MSE není k dispozici */ }
  try { return document.createElement("video").canPlayType(type) !== ""; } catch { return false; }
};
const capabilities = (): Capabilities => ({
  h264: supports('video/mp4; codecs="avc1.640029"'),
  hevc: supports('video/mp4; codecs="hvc1.1.6.L93.B0"'),
  // Main 10 je samostatný profil; hodně stažených souborů je desetibitových.
  hevc10: supports('video/mp4; codecs="hvc1.2.4.L153.B0"'),
  vp8: supports('video/webm; codecs="vp8"'),
  vp9: supports('video/mp4; codecs="vp09.00.10.08"'),
  av1: supports('video/mp4; codecs="av01.0.05M.08"'),
  aac: supports('audio/mp4; codecs="mp4a.40.2"'),
  mp3: supports('audio/mp4; codecs="mp4a.40.34"'),
  opus: supports('audio/mp4; codecs="opus"'),
  vorbis: supports('audio/webm; codecs="vorbis"'),
  ac3: supports('audio/mp4; codecs="ac-3"'),
  eac3: supports('audio/mp4; codecs="ec-3"'),
  flac: supports('audio/mp4; codecs="flac"'),
});

const MODE_LABEL: Record<PlaybackMode, string> = {
  direct: "PŘÍMÉ PŘEHRÁNÍ · BEZ PŘEVODU",
  remux: "PŘEBALENO · VIDEO BEZ PŘEKÓDOVÁNÍ",
  transcode: "PŘEKÓDOVÁNO",
};

/** Overlay fullscreen keeps the HTML cue layer. Native cues are only for the
 *  video element's own fullscreen (iOS), where those siblings are not shown. */
const nativeVideoFullscreen = (video: HTMLVideoElement, overlay: HTMLElement | null) => {
  if (document.fullscreenElement === overlay) return false;
  const webkitVideo = video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean };
  return document.fullscreenElement === video || Boolean(webkitVideo.webkitDisplayingFullscreen);
};

/** Keys the player claims for itself. Anything else (Escape) leaves focus alone. */
const SHORTCUT_KEYS = new Set([" ", "k", "ArrowLeft", "ArrowRight", "c", "t", "f"]);

/** Cílové kvality překódování; hodnoty musí odpovídat QUALITY_BITRATE na serveru. */
const QUALITIES = [1080, 720, 480];
const lowerQuality = (current: number | null) => current === null || current === 1080 ? 720 : current === 720 ? 480 : null;

const CHANNELS: Record<number, string> = { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" };
/** Soubory běžně označí víc stop stejným jazykem, takže musí být poznat i podle něčeho jiného. */
const trackLabel = (track: Track) => {
  const parts = [label(track.language)];
  if (track.title) parts.push(track.title);
  if (track.channels) parts.push(CHANNELS[track.channels] ?? `${track.channels}ch`);
  if (track.forced) parts.push("forced");
  return `${parts.join(" · ")} (${track.codec})`;
};

export function Player({ open, title, stream, subtitles, subtitleLanguage, progressKey, progressPoster, favorite, onToggleFavorite, onDownload, onDeviceDownload, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<string | null>(null);
  const modeRef = useRef<PlaybackMode>("transcode");
  const offsetRef = useRef(0);
  const probeDurationRef = useRef(0);
  const timeRef = useRef(0);
  const seekingRef = useRef(false);
  const seekInFlightRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const seekEpochRef = useRef(0);
  const catchupRef = useRef(0);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [addonSubtitle, setAddonSubtitle] = useState<Subtitle | null>(null);
  const [offset, setOffset] = useState(0);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState("");
  const stallsRef = useRef<number[]>([]);
  const bufferTimerRef = useRef<number | undefined>(undefined);
  const [qualityHint, setQualityHint] = useState<number | null>(null);
  const [downloadState, setDownloadState] = useState<"idle" | "busy" | "done">("idle");
  const [deviceDownloadBusy, setDeviceDownloadBusy] = useState(false);
  const [resumedFrom, setResumedFrom] = useState(0);
  const [subtitleText, setSubtitleText] = useState("");
  const [nativeSubtitles, setNativeSubtitles] = useState(false);
  // Hiding subtitles must not touch the session: switching the track on the server
  // restarts FFmpeg and waits for new segments. Only the rendering changes here, so the
  // track keeps running and comes back instantly.
  const [subtitlesHidden, setSubtitlesHidden] = useState(false);
  const subtitlesHiddenRef = useRef(false);
  const applySubtitleVisibilityRef = useRef<(() => void) | null>(null);
  const [mobileLandscape, setMobileLandscape] = useState(false);
  const [cssFullscreen, setCssFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimerRef = useRef<number | undefined>(undefined);
  const automaticFullscreenRef = useRef(false);
  // Hláška o navázání má informovat, ne překážet; po pěti sekundách zmizí.
  useEffect(() => {
    if (!resumedFrom) return;
    const timer = setTimeout(() => setResumedFrom(0), 5000);
    return () => clearTimeout(timer);
  }, [resumedFrom]);
  const reportRef = useRef<{ position: number; duration: number }>({ position: 0, duration: 0 });
  // Soubor z knihovny už na disku je, nabízet jeho stažení nedává smysl.
  const isLocal = Boolean(stream?.url?.startsWith("file://"));
  const addonSubtitles = [...(stream?.subtitles ?? []), ...subtitles];

  // Some browsers paint native WebVTT below the visible video box. Active cues
  // are mirrored into an HTML layer, and tracks stay in hidden mode so the
  // browser does not draw its own cue box. Overlay fullscreen must keep that
  // layer: Chromium on Windows otherwise promotes the video to a
  // DirectComposition plane and both the HTML overlay and native cues vanish.
  useEffect(() => {
    if (!open) return;
    const video = videoRef.current;
    if (!video) return;
    const bound = new Map<TextTrack, () => void>();
    const mirrored = new Set<TextTrack>();
    let useNativeRenderer = false;
    let syncingModes = false;
    let fullscreenSync = 0;

    const showActiveCues = () => {
      if (subtitlesHiddenRef.current) { setSubtitleText(""); return; }
      const lines = Array.from(video.textTracks)
        .filter((track) => mirrored.has(track) && track.activeCues)
        .flatMap((track) => Array.from(track.activeCues ?? []))
        .map((cue) => {
          const vttCue = cue as VTTCue;
          return typeof vttCue.getCueAsHTML === "function" ? vttCue.getCueAsHTML().textContent ?? "" : vttCue.text ?? "";
        })
        .map((text) => text.trim())
        .filter(Boolean);
      setSubtitleText(lines.join("\n"));
    };
    const syncTrackModes = () => {
      if (syncingModes) return;
      syncingModes = true;
      for (const track of Array.from(video.textTracks)) {
        if (track.mode === "showing") mirrored.add(track);
        // The picker never uses disabled: it unmounts the track or starts a new
        // session. Chromium may still flip an active track to disabled while
        // entering fullscreen, so a mirrored track is restored, not dropped.
        if (mirrored.has(track)) track.mode = useNativeRenderer && !subtitlesHiddenRef.current ? "showing" : "hidden";
      }
      syncingModes = false;
    };
    const bindTracks = () => {
      for (const track of Array.from(video.textTracks)) {
        if (bound.has(track)) continue;
        const onCueChange = showActiveCues;
        track.addEventListener("cuechange", onCueChange);
        bound.set(track, onCueChange);
      }
      syncTrackModes();
      showActiveCues();
    };
    const updateFullscreenMode = () => {
      useNativeRenderer = nativeVideoFullscreen(video, overlayRef.current);
      setNativeSubtitles(useNativeRenderer);
      bindTracks();
      cancelAnimationFrame(fullscreenSync);
      fullscreenSync = requestAnimationFrame(() => bindTracks());
    };

    bindTracks();
    applySubtitleVisibilityRef.current = () => { syncTrackModes(); showActiveCues(); };
    video.textTracks.addEventListener("addtrack", bindTracks);
    video.textTracks.addEventListener("change", bindTracks);
    video.addEventListener("loadedmetadata", bindTracks);
    document.addEventListener("fullscreenchange", updateFullscreenMode);
    video.addEventListener("webkitbeginfullscreen", updateFullscreenMode);
    video.addEventListener("webkitendfullscreen", updateFullscreenMode);
    return () => {
      cancelAnimationFrame(fullscreenSync);
      applySubtitleVisibilityRef.current = null;
      video.textTracks.removeEventListener("addtrack", bindTracks);
      video.textTracks.removeEventListener("change", bindTracks);
      video.removeEventListener("loadedmetadata", bindTracks);
      document.removeEventListener("fullscreenchange", updateFullscreenMode);
      video.removeEventListener("webkitbeginfullscreen", updateFullscreenMode);
      video.removeEventListener("webkitendfullscreen", updateFullscreenMode);
      for (const [track, listener] of bound) track.removeEventListener("cuechange", listener);
      for (const track of mirrored) if (track.mode === "hidden") track.mode = "showing";
      setSubtitleText("");
      setNativeSubtitles(false);
    };
  }, [open, session?.id, addonSubtitle?.url]);

  useEffect(() => {
    subtitlesHiddenRef.current = subtitlesHidden;
    applySubtitleVisibilityRef.current?.();
  }, [subtitlesHidden]);

  const detach = () => { hlsRef.current?.destroy(); hlsRef.current = null; };

  const attach = (url: string, mode: PlaybackMode, autoplay = true) => {
    const video = videoRef.current; if (!video) return;
    detach();
    if (mode === "direct") { video.src = url; if (autoplay) void video.play().catch(() => undefined); return; }
    video.removeAttribute("src");
    if (Hls.isSupported()) {
      // Delší buffer na obě strany znamená, že běžné přeskočení o pár sekund vyřídí
      // prohlížeč sám okamžitě, místo restartu FFmpeg na serveru.
      // maxBufferHole přemostí drobné mezery na hranicích segmentů (kopie videa řeže jen
      // na klíčových snímcích), místo aby na nich přehrávání zamrzlo.
      const hls = new Hls({ ...HLS_PLAYER_CONFIG });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (autoplay) void video.play().catch(() => undefined); });
      let recoveries = 0;
      hls.on(Hls.Events.FRAG_BUFFERED, () => { recoveries = 0; });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (hlsRef.current !== hls) return;
        if (ignoreHlsErrorDuringRestart(seekInFlightRef.current)) return;
        report(data.fatal ? "ERROR" : "WARN", `hls.js: ${data.details}`, {
          ...context(), type: data.type, fatal: data.fatal,
          httpStatus: data.response?.code, responseText: typeof data.response?.text === "string" ? data.response.text.slice(0, 120) : undefined,
          fragment: hostOf(data.frag?.url), url: hostOf(data.url),
        });
        if (!data.fatal) return;
        if (recoveries < 2) {
          recoveries += 1;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        }
        setError(`Přehrávání selhalo: ${data.details} (${data.type})`);
      });
      hls.loadSource(url); hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) { video.src = url; if (autoplay) void video.play().catch(() => undefined); }
    else {
      report("ERROR", "The browser supports neither MSE nor native HLS", { ...context(), userAgent: navigator.userAgent });
      setError("Tento prohlížeč nepodporuje HLS přehrávání.");
    }
  };

  const showTime = (value: number) => { timeRef.current = value; setTime(value); };

  /** Společný popis relace: bez něj je hlášení o chybě jen holé "nepřehrálo se". */
  const context = () => ({
    session: sessionRef.current ?? undefined, mode: modeRef.current, position: Math.round(timeRef.current),
    offset: Math.round(offsetRef.current), title,
    stream: hostOf(stream?.url ?? undefined) ?? (stream?.url?.startsWith("file://") ? "library" : undefined),
  });

  const applySession = (next: PlaybackSession, autoplay = true) => {
    sessionRef.current = next.id; modeRef.current = next.mode; offsetRef.current = next.offset;
    setSession(next); setOffset(next.offset); showTime(next.offset);
    if (next.duration) { probeDurationRef.current = next.duration; setDuration(next.duration); }
    attach(next.url, next.mode, autoplay);
  };

  useEffect(() => {
    if (!open || !stream?.url || !videoRef.current) return;
    let disposed = false; const video = videoRef.current; const epoch = ++seekEpochRef.current;
    setError(""); setBuffering(true); setTime(0); setDuration(0); setOffset(0); setScrub(null); setSession(null); setAddonSubtitle(null);
    timeRef.current = 0; offsetRef.current = 0; probeDurationRef.current = 0; seekingRef.current = false; pendingSeekRef.current = null;
    reportRef.current = { position: 0, duration: 0 }; setResumedFrom(0);
    stallsRef.current = []; setQualityHint(null); setDownloadState("idle");
    setSubtitlesHidden(false); subtitlesHiddenRef.current = false;
    // Rozkoukané: server zná pozici, přehrávání se rovnou spustí odtamtud.
    (async () => {
      const saved = progressKey ? await api.progressOf(progressKey).catch(() => null) : null;
      const from = saved && saved.position > 30 ? saved.position : 0;
      if (from) setResumedFrom(from);
      return { created: await api.startPlayback(stream, capabilities(), from), from };
    })().then(({ created, from }) => {
      if (disposed) { void api.stopPlayback(created.id); return; }
      applySession(created);
      report("DEBUG", `Playback session started in ${created.mode} mode`, {
        ...context(), mode: created.mode, hardware: created.hardware, acceleration: created.acceleration,
        video: created.video, audio: created.audio, resumedFrom: Math.round(from), capabilities: capabilities(),
      });
      // Server nemusí pro direct play spouštět FFmpeg, takže počáteční čas nastaví
      // přímo video element. U remuxu/transcode už je posun zahrnutý v URL relace.
      if (from > 0 && created.mode === "direct") {
        const move = () => { if (!disposed) { video.currentTime = from; showTime(from); } };
        if (video.readyState >= 1) move(); else video.addEventListener("loadedmetadata", move, { once: true });
      }
      // Vestavěné titulky si vybral server; když žádné nesedí, zkusíme preferovaný jazyk z doplňků.
      if (created.subtitleTrack === null) {
        setAddonSubtitle(addonSubtitles.find((item) => (item.lang ?? "").toLowerCase().startsWith(subtitleLanguage)) ?? null);
      }
    }).catch((value) => {
      const message = value instanceof Error ? value.message : String(value);
      report("ERROR", `Playback did not start: ${message}`, { ...context(), phase: "start", capabilities: capabilities() });
      setError(message);
    }).finally(() => { if (!disposed) setBuffering(false); });
    return () => {
      disposed = true; detach();
      if (bufferTimerRef.current !== undefined) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = undefined; }
      if (seekEpochRef.current === epoch) { seekEpochRef.current += 1; pendingSeekRef.current = null; seekingRef.current = false; seekInFlightRef.current = false; }
      video.pause(); video.removeAttribute("src"); video.load();
      const id = sessionRef.current; sessionRef.current = null; if (id) void api.stopPlayback(id);
    };
  }, [open, stream, progressKey]);

  /** Uvnitř vyrobené části skočíme okamžitě, jinak necháme převod začít znovu od nové pozice. */
  const seekTo = async (target: number) => {
    const video = videoRef.current; if (!video) return;
    const bounded = Math.max(0, duration ? Math.min(target, duration - 1) : target);
    setScrub(null); showTime(bounded);
    if (modeRef.current === "direct") { video.currentTime = bounded; return; }
    const token = ++catchupRef.current;
    const relative = bounded - offsetRef.current;
    const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    const plan = seekInFlightRef.current ? "restart" : planSeek(relative, end);
    if (plan === "native") { video.currentTime = relative; return; }
    if (plan === "wait") {
      const epoch = seekEpochRef.current;
      showBufferSoon();
      const covered = await waitForSeekable(
        () => video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0,
        relative, AHEAD_CATCHUP_MS,
        () => token !== catchupRef.current || epoch !== seekEpochRef.current,
      );
      clearBuffering();
      if (token !== catchupRef.current || epoch !== seekEpochRef.current) return;
      if (covered) { video.currentTime = relative; return; }
    }

    pendingSeekRef.current = bounded;
    if (seekInFlightRef.current) return;
    let id = sessionRef.current; if (!id) return;
    const epoch = seekEpochRef.current;
    const autoplay = !video.paused;
    // Keep the last frame. The previous HLS generation stays served for a few
    // seconds, so destroying it here only produced a black screen and bufferStalledError.
    seekInFlightRef.current = true; seekingRef.current = true; setBuffering(true); setError("");
    video.pause();
    try {
      while (pendingSeekRef.current !== null && epoch === seekEpochRef.current) {
        const requested = pendingSeekRef.current; pendingSeekRef.current = null;
        let recoveredDirectAt: number | null = null;
        let next: PlaybackSession;
        try { next = await api.seekPlayback(id, requested); }
        catch (value) {
          const message = value instanceof Error ? value.message : String(value);
          if (!message.includes("Relace přehrávání už neexistuje")) throw value;
          // Server mohl být mezitím restartován nebo uklidit nečinnou relaci.
          // Nová HLS relace začne rovnou na cíli; přímý stream si posune prohlížeč.
          next = await api.startPlayback(stream!, capabilities(), requested);
          id = next.id;
          if (next.mode === "direct") recoveredDirectAt = requested;
        }
        if (epoch !== seekEpochRef.current) return;
        // Když uživatel mezitím vybral jiné místo, starou generaci ani nepřipojujeme.
        if (pendingSeekRef.current !== null) continue;
        applySession(next, autoplay);
        if (recoveredDirectAt !== null) {
          const moveDirect = () => { const current = videoRef.current; if (current) current.currentTime = recoveredDirectAt!; showTime(recoveredDirectAt!); };
          if (videoRef.current && videoRef.current.readyState >= 1) moveDirect();
          else videoRef.current?.addEventListener("loadedmetadata", moveDirect, { once: true });
        }
      }
    }
    catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      report("ERROR", `Seek failed: ${message}`, { ...context(), phase: "seek", target: Math.round(bounded) });
      if (epoch === seekEpochRef.current) setError(message);
    }
    finally {
      if (epoch === seekEpochRef.current) { pendingSeekRef.current = null; seekInFlightRef.current = false; seekingRef.current = false; setBuffering(false); }
    }
  };

  /** Jiná stopa nebo kvalita znamená jiné mapování pro FFmpeg, takže se převod restartuje na aktuální pozici. */
  const changeTrack = async (changes: { audio?: number; subtitle?: number | null; quality?: number | null }) => {
    const id = sessionRef.current; if (!id) return;
    const at = timeRef.current;
    const video = videoRef.current;
    seekInFlightRef.current = true; seekingRef.current = true; setBuffering(true); setError("");
    video?.pause();
    try {
      // Když spojení selže cestou, server přepnutí stejně provede a stav se rozejde;
      // druhý pokus vrátí to, v čem relace opravdu je.
      const next = await api.setTrack(id, { ...changes, time: at })
        .catch((error) => { if (error instanceof ApiError) throw error; return api.setTrack(id, { ...changes, time: at }); });
      applySession(next);
      // Návrat na originál může skončit přímým přehráváním od nuly; pozici si posuneme sami.
      if (next.mode === "direct" && at > 0) {
        const moveDirect = () => { const current = videoRef.current; if (current) current.currentTime = at; showTime(at); };
        if (videoRef.current && videoRef.current.readyState >= 1) moveDirect();
        else videoRef.current?.addEventListener("loadedmetadata", moveDirect, { once: true });
      }
    }
    catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      report("ERROR", `Track switch failed: ${message}`, { ...context(), phase: "track", changes });
      setError(message);
    }
    finally { seekInFlightRef.current = false; seekingRef.current = false; setBuffering(false); }
  };

  const changeQuality = (value: number | null) => {
    stallsRef.current = []; setQualityHint(null);
    void changeTrack({ quality: value });
  };

  /** Mikrozadrhnutí do 400 ms hlášku vůbec nerozsvítí; blikala by při každém dorovnání bufferu. */
  const showBufferSoon = () => {
    if (bufferTimerRef.current !== undefined) return;
    bufferTimerRef.current = window.setTimeout(() => { bufferTimerRef.current = undefined; setBuffering(true); }, 400);
  };
  const clearBuffering = () => {
    if (bufferTimerRef.current !== undefined) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = undefined; }
    setBuffering(false);
  };

  /** Opakované zadrhnutí mimo seek je signál slabé linky; nabídneme nižší kvalitu. */
  const noteStall = () => {
    showBufferSoon();
    const video = videoRef.current;
    if (!video || video.seeking || seekingRef.current || video.currentTime < 1) return;
    const now = Date.now();
    stallsRef.current = [...stallsRef.current.filter((at) => now - at < 60_000), now];
    if (stallsRef.current.length < 3) return;
    // Nižší kvalita srazí datový tok, takže zadrhávání kvůli síti skutečně spraví.
    // Znamená ale překódování, a to bez hardwarové akcelerace slabý procesor
    // nestíhá -- pak by rada uškodila víc, než pomohla. Ptáme se proto serveru,
    // jestli akceleraci má; příznak hardware to neřekne, ten je při přebalení
    // vždy nepravdivý, protože se v něm VAAPI nepoužívá.
    report("WARN", "Playback keeps stalling", {
      ...context(), stalls: stallsRef.current.length, quality: session?.quality ?? null,
      hardware: session?.hardware, acceleration: session?.acceleration,
    });
    if (!session?.acceleration) return;
    const target = lowerQuality(session?.quality ?? null);
    if (target !== null) setQualityHint(target);
  };

  const chooseSubtitle = async (value: string) => {
    // Touching the picker is an explicit instruction, so it always ends the quick hide:
    // the chosen track shows up right away and turning subtitles off clears the crossed icon.
    setSubtitlesHidden(false);
    if (value.startsWith("embedded:")) { setAddonSubtitle(null); await changeTrack({ subtitle: Number(value.slice(9)) }); return; }
    if (session?.subtitleTrack !== null && session !== null) await changeTrack({ subtitle: null });
    setAddonSubtitle(value.startsWith("addon:") ? addonSubtitles[Number(value.slice(6))] ?? null : null);
  };

  // Pozici hlásíme po deseti sekundách a ještě jednou při zavření, ať se nic neztratí.
  useEffect(() => {
    if (!open || !progressKey) return;
    const send = () => {
      const { position, duration } = reportRef.current;
      if (!duration || position < 5) return;
      void api.saveProgress({
        key: progressKey, position, duration, title,
        path: stream?.url?.startsWith("file://") ? stream.url.slice(7) : undefined,
        poster: progressPoster,
      }).catch(() => undefined);
    };
    const timer = setInterval(send, 10_000);
    return () => { clearInterval(timer); send(); };
  }, [open, progressKey, title, progressPoster]);

  const toggle = () => { const video = videoRef.current; if (!video) return; if (video.paused) void video.play().catch(() => undefined); else video.pause(); };

  const clearControlsTimer = () => {
    if (controlsTimerRef.current === undefined) return;
    clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = undefined;
  };
  const revealControls = () => {
    setControlsVisible(true);
    clearControlsTimer();
    if (videoRef.current?.paused || buffering || error || scrub !== null) return;
    controlsTimerRef.current = window.setTimeout(() => {
      controlsTimerRef.current = undefined;
      setControlsVisible(false);
    }, 3500);
  };
  useEffect(() => {
    if (!open) { clearControlsTimer(); setControlsVisible(true); return; }
    if (paused || buffering || error || scrub !== null) { clearControlsTimer(); setControlsVisible(true); return; }
    revealControls();
    return clearControlsTimer;
  }, [open, paused, buffering, error, scrub]);

  /** Fullscreen musí obsahovat celou naši vrstvu. iOS umí u videa jen vlastní
   * přehrávač, který u průběžně vznikajícího HLS nezná délku celého filmu. */
  const enterBrowserFullscreen = async () => {
    if (document.fullscreenElement) return true;
    const node = overlayRef.current as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    try {
      if (node?.requestFullscreen) {
        await node.requestFullscreen();
        return true;
      }
      if (node?.webkitRequestFullscreen) {
        await node.webkitRequestFullscreen();
        return true;
      }
    } catch { /* Bez uživatelského gesta může prohlížeč automatický fullscreen odmítnout. */ }
    return false;
  };

  const toggleFullscreen = async () => {
    if (document.fullscreenElement === overlayRef.current) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (cssFullscreen) { setCssFullscreen(false); return; }
    // Safari na iPhonu nepodporuje fullscreen běžného elementu. Místo přechodu
    // do nativního video přehrávače použijeme kompaktní vrstvu přes celý viewport.
    if (!await enterBrowserFullscreen()) setCssFullscreen(true);
  };

  /** Otočení telefonu na šířku maximalizuje přehrávač a, dovolí-li to prohlížeč,
   * přejde i do nativního fullscreenu. CSS varianta funguje vždy. */
  useEffect(() => {
    if (!open) { setMobileLandscape(false); setCssFullscreen(false); automaticFullscreenRef.current = false; return; }
    const orientation = window.matchMedia("(orientation: landscape)");
    let previous = false;
    const update = () => {
      const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches;
      const landscape = orientation.matches && Math.min(window.innerWidth, window.innerHeight) <= 700 && Math.max(window.innerWidth, window.innerHeight) <= 1200;
      setMobileLandscape(landscape);
      if (landscape && touchDevice && !previous) {
        window.setTimeout(() => void enterBrowserFullscreen().then((entered) => {
          automaticFullscreenRef.current = entered;
          if (!entered) setCssFullscreen(true);
        }), 80);
      } else if (!landscape && previous) {
        if (automaticFullscreenRef.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        automaticFullscreenRef.current = false;
        setCssFullscreen(false);
      }
      previous = landscape;
    };
    update();
    orientation.addEventListener?.("change", update);
    window.addEventListener("orientationchange", update);
    window.addEventListener("resize", update);
    return () => {
      orientation.removeEventListener?.("change", update);
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  /** Přehrávání běží dál; do fronty se přidá tentýž stream, který právě hraje. */
  const download = async () => {
    if (downloadState !== "idle") return;
    setDownloadState("busy");
    setDownloadState(await onDownload() ? "done" : "idle");
  };

  const downloadToDevice = async () => {
    if (deviceDownloadBusy) return;
    setDeviceDownloadBusy(true);
    try { await onDeviceDownload(); }
    finally { setDeviceDownloadBusy(false); }
  };

  const closePlayer = () => {
    videoRef.current?.pause();
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    setCssFullscreen(false);
    const fullscreen = document.fullscreenElement;
    onClose();
    // Nejdřív sundáme overlay, teprve potom fullscreen. Jinak Safari při křížku
    // nahoře vysune záložky ještě přes video.
    if (fullscreen) window.setTimeout(() => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    }, 80);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLSelectElement) return;
      if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
      revealControls();
      // A mouse click leaves focus on the button. The browser draws no ring for it, but the
      // first shortcut switches it to keyboard modality and lights the ring on a control that
      // has nothing to do with that shortcut, so the player drops focus first.
      if (SHORTCUT_KEYS.has(event.key)) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && overlayRef.current?.contains(active)) active.blur();
      }
      if (event.key === " " || event.key === "k") { event.preventDefault(); toggle(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); void seekTo(timeRef.current - 10); }
      else if (event.key === "ArrowRight") { event.preventDefault(); void seekTo(timeRef.current + 10); }
      else if (event.key === "c" || event.key === "t") { event.preventDefault(); setSubtitlesHidden((value) => !value); }
      else if (event.key === "f") void toggleFullscreen();
      else if (event.key === "Escape" && !document.fullscreenElement) closePlayer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, time, duration, cssFullscreen]);

  if (!open) return null;
  const position = scrub ?? time;
  const seekable = duration || Math.max(time, 1);
  const subtitleValue = session?.subtitleTrack !== null && session?.subtitleTrack !== undefined
    ? `embedded:${session.subtitleTrack}`
    : addonSubtitle ? `addon:${addonSubtitles.indexOf(addonSubtitle)}` : "off";

  return <div ref={overlayRef} className={`player-overlay${nativeSubtitles ? " native-subtitles" : ""}${mobileLandscape || cssFullscreen ? " mobile-landscape" : ""}${controlsVisible ? "" : " controls-hidden"}`} role="dialog" aria-modal="true" onPointerMove={revealControls} onPointerDown={revealControls}>
    <div className="player-head">
      <div><small>{session ? MODE_LABEL[session.mode] : "PŘIPRAVUJI"}{session?.hardware ? " · VAAPI" : ""}</small><strong>{title}</strong></div>
      <button className="icon-button" aria-label="Zavřít přehrávač" onClick={closePlayer}><X /></button>
    </div>
    <div className="player-host">
      <video ref={videoRef} playsInline
        onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
        onTimeUpdate={(event) => {
          const absolute = offsetRef.current + event.currentTarget.currentTime;
          reportRef.current = { position: absolute, duration: duration || probeDurationRef.current };
          if (scrub === null && !seekingRef.current) showTime(absolute);
        }}
        onDurationChange={(event) => { const value = event.currentTarget.duration; if (Number.isFinite(value) && (modeRef.current === "direct" || !probeDurationRef.current)) setDuration(value); }}
        onWaiting={noteStall} onPlaying={clearBuffering}
        onError={() => {
          const media = videoRef.current?.error;
          report("ERROR", `The video element refused the stream (code ${media?.code ?? "?"})`, {
            ...context(), code: media?.code, detail: media?.message,
            networkState: videoRef.current?.networkState, readyState: videoRef.current?.readyState,
          });
          setError("Prohlížeč nedokázal přehrát tento stream.");
        }}>
        {addonSubtitle && <track key={`${addonSubtitle.url}:${offset}`} kind="subtitles" src={subtitleUrl(addonSubtitle.url, offset)} srcLang={addonSubtitle.lang || subtitleLanguage} label={label(addonSubtitle.lang)} default />}
      </video>
      {subtitleText && <div className="player-subtitles" aria-live="off">{subtitleText}</div>}
      {resumedFrom > 0 && <div className="player-resumed">Navázáno na {fmt(resumedFrom)}<button onClick={() => { setResumedFrom(0); void seekTo(0); }}>Přehrát od začátku</button></div>}
      {buffering && !error && <div className="player-buffer">Načítám…</div>}
      {error && <div className="player-error">{error}</div>}
      {qualityHint !== null && !error && <div className="player-hint">
        <span>Přehrávání se zadrhává.</span>
        <button onClick={() => changeQuality(qualityHint)}>Snížit kvalitu na {qualityHint}p</button>
        <button className="icon-button" aria-label="Skrýt doporučení" onClick={() => { stallsRef.current = []; setQualityHint(null); }}><X /></button>
      </div>}
    </div>
    <div className="timeline">
      <span>{fmt(position)}</span>
      <TimelineBar value={Math.min(position, seekable)} max={seekable}
        onScrub={(next) => { revealControls(); setScrub(next); }}
        onSeek={(next) => void seekTo(next)}
        onReveal={revealControls} />
      <span>{fmt(duration)}</span>
    </div>
    <div className="player-controls">
      <button className="icon-button player-close-control" aria-label="Zavřít přehrávač" onClick={closePlayer}><X /></button>
      <button onClick={() => void seekTo(timeRef.current - 10)}><RotateCcw /> 10</button>
      <button className="play-toggle" aria-label={paused ? "Přehrát" : "Pozastavit"} onClick={toggle}>{paused ? <Play /> : <Pause />}</button>
      <button onClick={() => void seekTo(timeRef.current + 10)}>10 <RotateCw /></button>
      <Volume2 />
      <input aria-label="Hlasitost" className="volume" type="range" min="0" max="100" defaultValue="100" onChange={(event) => { const video = videoRef.current; if (video) video.volume = Number(event.target.value) / 100; }} />

      {session && <label className="track-picker" title="Kvalita">
        <SlidersHorizontal />
        <select aria-label="Kvalita" value={session.quality ?? "original"}
          onChange={(event) => changeQuality(event.target.value === "original" ? null : Number(event.target.value))}>
          <option value="original">Originál</option>
          {QUALITIES.map((height) => <option key={height} value={height}>{height}p</option>)}
        </select>
      </label>}

      {(session?.audioTracks.length ?? 0) > 1 && <label className="track-picker" title="Zvuková stopa">
        <AudioLines />
        <select aria-label="Zvuková stopa" value={session?.audioTrack ?? 0} onChange={(event) => void changeTrack({ audio: Number(event.target.value) })}>
          {session?.audioTracks.map((track) => <option key={track.index} value={track.index}>{trackLabel(track)}</option>)}
        </select>
      </label>}

      {((session?.subtitleTracks.length ?? 0) > 0 || addonSubtitles.length > 0) && <div className="track-picker">
        <button className={`picker-toggle${subtitlesHidden ? " off" : ""}`} disabled={subtitleValue === "off"}
          onClick={() => setSubtitlesHidden(!subtitlesHidden)}
          title={subtitleValue === "off" ? "Titulky" : subtitlesHidden ? "Zobrazit titulky (C)" : "Skrýt titulky (C)"}
          aria-pressed={!subtitlesHidden} aria-label={subtitlesHidden ? "Zobrazit titulky" : "Skrýt titulky"}>
          {subtitlesHidden ? <CaptionsOff /> : <Captions />}
        </button>
        <select aria-label="Titulky" value={subtitleValue} onChange={(event) => void chooseSubtitle(event.target.value)}>
          <option value="off">Vypnuto</option>
          {session?.subtitleTracks.map((track) => <option key={`e${track.index}`} value={`embedded:${track.index}`}>Vestavěné · {trackLabel(track)}</option>)}
          {addonSubtitles.map((item, index) => <option key={`a${index}`} value={`addon:${index}`}>Doplněk · {label(item.lang)}{item.addonName ? ` · ${item.addonName}` : ""}</option>)}
        </select>
      </div>}

      {session?.video && <span className="codec-badge"><Gauge /> {session.video}{session.audio ? ` · ${session.audio}` : ""}</span>}
      {onToggleFavorite && <button className={`player-star ${favorite ? "on" : ""}`} title={favorite ? "Odebrat z oblíbených" : "Přidat do oblíbených"} onClick={onToggleFavorite}>
        <Star/> <span>{favorite ? "V oblíbených" : "Oblíbené"}</span>
      </button>}
      {!isLocal && <button className="player-action" disabled={downloadState === "busy"} onClick={() => void download()} title="Uložit do knihovny na serveru" aria-label="Uložit do knihovny na serveru">
        {downloadState === "done" ? <><Check /> <span>Ve frontě</span></> : <><HardDrive /> <span>{downloadState === "busy" ? "Přidávám…" : "Do knihovny"}</span></>}
      </button>}
      <button className="player-action" disabled={deviceDownloadBusy} onClick={() => void downloadToDevice()} title="Uložit soubor do tohoto zařízení" aria-label="Uložit soubor do tohoto zařízení">
        <Download /> <span>{deviceDownloadBusy ? "Připravuji…" : "Do zařízení"}</span>
      </button>
      <button className="player-action fullscreen-action" onClick={() => void toggleFullscreen()} title={cssFullscreen ? "Ukončit celou obrazovku" : "Celá obrazovka"} aria-label={cssFullscreen ? "Ukončit celou obrazovku" : "Celá obrazovka"}>{cssFullscreen ? <Minimize/> : <Maximize/>} <span>{cssFullscreen ? "Ukončit celou obrazovku" : "Celá obrazovka"}</span></button>
    </div>
  </div>;
}
