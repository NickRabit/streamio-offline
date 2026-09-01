import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { AudioLines, Gauge, Maximize, Pause, Play, RotateCcw, RotateCw, Subtitles, Volume2, X } from "lucide-react";
import { api, subtitleUrl } from "./api";
import { label } from "./languages";
import type { Capabilities, PlaybackMode, PlaybackSession, Stream, Subtitle, Track } from "./types";

interface Props { open: boolean; title: string; stream: Stream | null; subtitles: Subtitle[]; subtitleLanguage: string; onClose: () => void }

const fmt = (seconds: number) => !Number.isFinite(seconds) ? "0:00" : `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ""}${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Prohlížeč sám nejlépe ví, co zvládne. Server podle toho rozhodne, co kopírovat a co překódovat. */
const supports = (type: string) => {
  try { if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported) return MediaSource.isTypeSupported(type); } catch { /* MSE není k dispozici */ }
  try { return document.createElement("video").canPlayType(type) !== ""; } catch { return false; }
};
const capabilities = (): Capabilities => ({
  h264: supports('video/mp4; codecs="avc1.640029"'),
  hevc: supports('video/mp4; codecs="hvc1.1.6.L93.B0"'),
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

const CHANNELS: Record<number, string> = { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" };
/** Soubory běžně označí víc stop stejným jazykem, takže musí být poznat i podle něčeho jiného. */
const trackLabel = (track: Track) => {
  const parts = [label(track.language)];
  if (track.title) parts.push(track.title);
  if (track.channels) parts.push(CHANNELS[track.channels] ?? `${track.channels}ch`);
  if (track.forced) parts.push("forced");
  return `${parts.join(" · ")} (${track.codec})`;
};

export function Player({ open, title, stream, subtitles, subtitleLanguage, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<string | null>(null);
  const modeRef = useRef<PlaybackMode>("transcode");
  const offsetRef = useRef(0);
  const probeDurationRef = useRef(0);
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [addonSubtitle, setAddonSubtitle] = useState<Subtitle | null>(null);
  const [offset, setOffset] = useState(0);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState("");
  const addonSubtitles = [...(stream?.subtitles ?? []), ...subtitles];

  /** Restart převodu smaže starou generaci, takže odpojení musí předběhnout požadavek na server. */
  const detach = () => { hlsRef.current?.destroy(); hlsRef.current = null; };

  const attach = (url: string, mode: PlaybackMode) => {
    const video = videoRef.current; if (!video) return;
    detach();
    if (mode === "direct") { video.src = url; void video.play().catch(() => undefined); return; }
    video.removeAttribute("src");
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30, backBufferLength: 60 });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => undefined));
      // Odepsaná instance ještě chvíli dobíhá; její chyby už nejsou naše.
      hls.on(Hls.Events.ERROR, (_event, data) => { if (hlsRef.current === hls && data.fatal) setError(`Přehrávání selhalo: ${data.details}`); });
      hls.loadSource(url); hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) { video.src = url; void video.play().catch(() => undefined); }
    else setError("Tento prohlížeč nepodporuje HLS přehrávání.");
  };

  const applySession = (next: PlaybackSession) => {
    sessionRef.current = next.id; modeRef.current = next.mode; offsetRef.current = next.offset;
    setSession(next); setOffset(next.offset); setTime(next.offset);
    if (next.duration) { probeDurationRef.current = next.duration; setDuration(next.duration); }
    attach(next.url, next.mode);
  };

  useEffect(() => {
    if (!open || !stream?.url || !videoRef.current) return;
    let disposed = false; const video = videoRef.current;
    setError(""); setBuffering(true); setTime(0); setDuration(0); setOffset(0); setScrub(null); setSession(null); setAddonSubtitle(null);
    offsetRef.current = 0; probeDurationRef.current = 0;
    api.startPlayback(stream, capabilities()).then((created) => {
      if (disposed) { void api.stopPlayback(created.id); return; }
      applySession(created);
      // Vestavěné titulky si vybral server; když žádné nesedí, zkusíme preferovaný jazyk z doplňků.
      if (created.subtitleTrack === null) {
        setAddonSubtitle(addonSubtitles.find((item) => (item.lang ?? "").toLowerCase().startsWith(subtitleLanguage)) ?? null);
      }
    }).catch((value) => setError(value instanceof Error ? value.message : String(value))).finally(() => { if (!disposed) setBuffering(false); });
    return () => {
      disposed = true; detach();
      video.pause(); video.removeAttribute("src"); video.load();
      const id = sessionRef.current; sessionRef.current = null; if (id) void api.stopPlayback(id);
    };
  }, [open, stream]);

  /** Uvnitř vyrobené části skočíme okamžitě, jinak necháme převod začít znovu od nové pozice. */
  const seekTo = async (target: number) => {
    const video = videoRef.current; if (!video) return;
    const bounded = Math.max(0, duration ? Math.min(target, duration - 1) : target);
    if (modeRef.current === "direct") { video.currentTime = bounded; setTime(bounded); return; }
    const relative = bounded - offsetRef.current;
    const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    if (relative >= 0 && relative <= Math.max(0, end - 0.5)) { video.currentTime = relative; setTime(bounded); return; }
    const id = sessionRef.current; if (!id) return;
    setBuffering(true); setTime(bounded); setError(""); detach();
    try { applySession(await api.seekPlayback(id, bounded)); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBuffering(false); }
  };

  /** Jiná stopa znamená jiné mapování pro FFmpeg, takže se převod restartuje na aktuální pozici. */
  const changeTrack = async (changes: { audio?: number; subtitle?: number | null }) => {
    const id = sessionRef.current; if (!id) return;
    setBuffering(true); setError(""); detach();
    try { applySession(await api.setTrack(id, { ...changes, time })); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBuffering(false); }
  };

  const chooseSubtitle = async (value: string) => {
    if (value.startsWith("embedded:")) { setAddonSubtitle(null); await changeTrack({ subtitle: Number(value.slice(9)) }); return; }
    if (session?.subtitleTrack !== null && session !== null) await changeTrack({ subtitle: null });
    setAddonSubtitle(value.startsWith("addon:") ? addonSubtitles[Number(value.slice(6))] ?? null : null);
  };

  const toggle = () => { const video = videoRef.current; if (!video) return; if (video.paused) void video.play().catch(() => undefined); else video.pause(); };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLSelectElement) return;
      if (event.target instanceof HTMLInputElement && event.target.type !== "range") return;
      if (event.key === " " || event.key === "k") { event.preventDefault(); toggle(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); void seekTo(time - 10); }
      else if (event.key === "ArrowRight") { event.preventDefault(); void seekTo(time + 10); }
      else if (event.key === "f") void videoRef.current?.requestFullscreen().catch(() => undefined);
      else if (event.key === "Escape" && !document.fullscreenElement) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, time, duration]);

  if (!open) return null;
  const position = scrub ?? time;
  const seekable = duration || Math.max(time, 1);
  const subtitleValue = session?.subtitleTrack !== null && session?.subtitleTrack !== undefined
    ? `embedded:${session.subtitleTrack}`
    : addonSubtitle ? `addon:${addonSubtitles.indexOf(addonSubtitle)}` : "off";

  return <div className="player-overlay" role="dialog" aria-modal="true">
    <div className="player-head">
      <div><small>{session ? MODE_LABEL[session.mode] : "PŘIPRAVUJI"}{session?.hardware ? " · VAAPI" : ""}</small><strong>{title}</strong></div>
      <button className="icon-button" aria-label="Zavřít přehrávač" onClick={onClose}><X /></button>
    </div>
    <div className="player-host">
      <video ref={videoRef} playsInline
        onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
        onTimeUpdate={(event) => { if (scrub === null) setTime(offsetRef.current + event.currentTarget.currentTime); }}
        onDurationChange={(event) => { const value = event.currentTarget.duration; if (Number.isFinite(value) && (modeRef.current === "direct" || !probeDurationRef.current)) setDuration(value); }}
        onWaiting={() => setBuffering(true)} onPlaying={() => setBuffering(false)}
        onError={() => setError("Prohlížeč nedokázal přehrát tento stream.")}>
        {addonSubtitle && <track key={`${addonSubtitle.url}:${offset}`} kind="subtitles" src={subtitleUrl(addonSubtitle.url, offset)} srcLang={addonSubtitle.lang || subtitleLanguage} label={label(addonSubtitle.lang)} default />}
      </video>
      {buffering && !error && <div className="player-buffer">Načítám…</div>}
      {error && <div className="player-error">{error}</div>}
    </div>
    <div className="timeline">
      <span>{fmt(position)}</span>
      <input aria-label="Pozice videa" type="range" min="0" max={seekable} step="1" value={Math.min(position, seekable)}
        onChange={(event) => setScrub(Number(event.target.value))}
        onPointerUp={() => { if (scrub !== null) { const target = scrub; setScrub(null); void seekTo(target); } }}
        onKeyUp={() => { if (scrub !== null) { const target = scrub; setScrub(null); void seekTo(target); } }} />
      <span>{fmt(duration)}</span>
    </div>
    <div className="player-controls">
      <button onClick={() => void seekTo(time - 10)}><RotateCcw /> 10</button>
      <button className="play-toggle" aria-label={paused ? "Přehrát" : "Pozastavit"} onClick={toggle}>{paused ? <Play /> : <Pause />}</button>
      <button onClick={() => void seekTo(time + 10)}>10 <RotateCw /></button>
      <Volume2 />
      <input aria-label="Hlasitost" className="volume" type="range" min="0" max="100" defaultValue="100" onChange={(event) => { const video = videoRef.current; if (video) video.volume = Number(event.target.value) / 100; }} />

      {(session?.audioTracks.length ?? 0) > 1 && <label className="track-picker" title="Zvuková stopa">
        <AudioLines />
        <select aria-label="Zvuková stopa" value={session?.audioTrack ?? 0} onChange={(event) => void changeTrack({ audio: Number(event.target.value) })}>
          {session?.audioTracks.map((track) => <option key={track.index} value={track.index}>{trackLabel(track)}</option>)}
        </select>
      </label>}

      {((session?.subtitleTracks.length ?? 0) > 0 || addonSubtitles.length > 0) && <label className="track-picker" title="Titulky">
        <Subtitles />
        <select aria-label="Titulky" value={subtitleValue} onChange={(event) => void chooseSubtitle(event.target.value)}>
          <option value="off">Vypnuto</option>
          {session?.subtitleTracks.map((track) => <option key={`e${track.index}`} value={`embedded:${track.index}`}>Vestavěné · {trackLabel(track)}</option>)}
          {addonSubtitles.map((item, index) => <option key={`a${index}`} value={`addon:${index}`}>Doplněk · {label(item.lang)}{item.addonName ? ` · ${item.addonName}` : ""}</option>)}
        </select>
      </label>}

      {session?.video && <span className="codec-badge"><Gauge /> {session.video}{session.audio ? ` · ${session.audio}` : ""}</span>}
      <button onClick={() => void videoRef.current?.requestFullscreen().catch(() => undefined)}><Maximize /> Celá obrazovka</button>
    </div>
  </div>;
}
