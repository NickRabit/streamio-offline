import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { Maximize, Pause, Play, RotateCcw, RotateCw, Volume2, X } from "lucide-react";
import { api, subtitleUrl } from "./api";
import type { Stream, Subtitle } from "./types";

interface Props { open: boolean; title: string; stream: Stream | null; subtitles: Subtitle[]; onClose: () => void }
const fmt = (seconds: number) => !Number.isFinite(seconds) ? "0:00" : `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ""}${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function Player({ open, title, stream, subtitles, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null); const sessionRef = useRef<string | null>(null);
  const [paused, setPaused] = useState(true); const [time, setTime] = useState(0); const [duration, setDuration] = useState(0); const [buffering, setBuffering] = useState(false); const [error, setError] = useState("");
  const allSubtitles = [...(stream?.subtitles ?? []), ...subtitles]; const preferred = allSubtitles.find((item) => /^(cs|cz|cze)$/i.test(item.lang ?? "")) ?? allSubtitles[0];

  useEffect(() => {
    if (!open || !stream?.url || !videoRef.current) return;
    let disposed = false; let hls: Hls | null = null; const video = videoRef.current; setError(""); setBuffering(true); setTime(0); setDuration(0);
    api.startPlayback(stream).then((session) => {
      if (disposed) { void api.stopPlayback(session.id); return; } sessionRef.current = session.id;
      if (Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 30, backBufferLength: 30 }); hls.loadSource(session.url); hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play()); hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) setError(`Přehrávání selhalo: ${data.details}`); });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) { video.src = session.url; void video.play(); }
      else setError("Tento prohlížeč nepodporuje HLS přehrávání.");
    }).catch((value) => setError(value instanceof Error ? value.message : String(value))).finally(() => { if (!disposed) setBuffering(false); });
    return () => { disposed = true; hls?.destroy(); video.pause(); video.removeAttribute("src"); video.load(); const id = sessionRef.current; sessionRef.current = null; if (id) void api.stopPlayback(id); };
  }, [open, stream]);
  if (!open) return null;
  const video = videoRef.current;
  return <div className="player-overlay" role="dialog" aria-modal="true">
    <div className="player-head"><div><small>PŘEHRÁVÁNÍ · KOMPATIBILNÍ REŽIM</small><strong>{title}</strong></div><button className="icon-button" aria-label="Zavřít přehrávač" onClick={onClose}><X /></button></div>
    <div className="player-host"><video ref={videoRef} playsInline onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onDurationChange={(e) => setDuration(e.currentTarget.duration)} onWaiting={() => setBuffering(true)} onPlaying={() => setBuffering(false)} onError={() => setError("Prohlížeč nedokázal přehrát převedený stream.")}>{preferred && <track key={preferred.url} kind="subtitles" src={subtitleUrl(preferred.url)} srcLang={preferred.lang || "cs"} label={(preferred.lang || "Titulky").toUpperCase()} default/>}</video>{buffering && !error && <div className="player-buffer">Připravuji kompatibilní stream…</div>}{error && <div className="player-error">{error}</div>}</div>
    <div className="timeline"><span>{fmt(time)}</span><input aria-label="Pozice videa" type="range" min="0" max={Number.isFinite(duration) && duration > 0 ? duration : Math.max(time, 1)} value={time} onChange={(event) => { if (video) video.currentTime = Number(event.target.value); }}/><span>{fmt(duration)}</span></div>
    <div className="player-controls"><button onClick={() => { if (video) video.currentTime = Math.max(0, video.currentTime - 10); }}><RotateCcw/> 10</button><button className="play-toggle" aria-label={paused ? "Přehrát" : "Pozastavit"} onClick={() => { if (video) paused ? void video.play() : video.pause(); }}>{paused ? <Play/> : <Pause/>}</button><button onClick={() => { if (video) video.currentTime = Math.min(duration || Infinity, video.currentTime + 10); }}>10 <RotateCw/></button><Volume2/><input aria-label="Hlasitost" className="volume" type="range" min="0" max="100" defaultValue="100" onChange={(event) => { if (video) video.volume = Number(event.target.value) / 100; }}/>{preferred && <span>CC {preferred.lang?.toUpperCase() || "ON"}</span>}<button onClick={() => void video?.requestFullscreen()}><Maximize/> Celá obrazovka</button></div>
  </div>;
}
