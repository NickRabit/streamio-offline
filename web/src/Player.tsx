import { useEffect, useRef, useState } from "react";
import { Maximize, Pause, Play, RotateCcw, RotateCw, Volume2, X } from "lucide-react";
import StremioVideo from "@stremio/stremio-video";
import { playableStream } from "./api";
import type { Stream, Subtitle } from "./types";

interface Props { open: boolean; title: string; stream: Stream | null; subtitles: Subtitle[]; onClose: () => void }
const fmt = (ms: number | null) => !Number.isFinite(ms) ? "0:00" : `${Math.floor((ms ?? 0) / 3600000) ? `${Math.floor((ms ?? 0) / 3600000)}:` : ""}${String(Math.floor(((ms ?? 0) % 3600000) / 60000)).padStart(2, "0")}:${String(Math.floor(((ms ?? 0) % 60000) / 1000)).padStart(2, "0")}`;

export function Player({ open, title, stream, subtitles, onClose }: Props) {
  const host = useRef<HTMLDivElement>(null); const engine = useRef<StremioVideo | null>(null);
  const [paused, setPaused] = useState(true); const [time, setTime] = useState(0); const [duration, setDuration] = useState(0); const [buffering, setBuffering] = useState(false); const [error, setError] = useState("");
  const dispatch = (action: Record<string, unknown>) => engine.current?.dispatch(action, { containerElement: host.current });
  const setProp = (name: string, value: unknown) => dispatch({ type: "setProp", propName: name, propValue: value });

  useEffect(() => {
    const video = new StremioVideo(); engine.current = video;
    const prop = (name: string, value: unknown) => { if (name === "paused") setPaused(Boolean(value)); if (name === "time") setTime(Number(value) || 0); if (name === "duration") setDuration(Number(value) || 0); if (name === "buffering") setBuffering(Boolean(value)); };
    video.on("implementationChanged", (manifest: { props?: string[] }) => manifest.props?.forEach((propName) => video.dispatch({ type: "observeProp", propName }))); video.on("propChanged", prop); video.on("propValue", prop);
    video.on("error", (value: unknown) => setError(typeof value === "object" ? JSON.stringify(value) : String(value)));
    return () => { try { video.destroy(); } catch { /* already closed */ } engine.current = null; };
  }, []);

  useEffect(() => {
    if (!open || !stream || !host.current) return;
    setError(""); const prepared = playableStream(stream);
    dispatch({ type: "command", commandName: "load", commandArgs: { stream: { ...prepared, subtitles: [...(stream.subtitles ?? []), ...subtitles] }, autoplay: true, time: 0, platform: "web", streamingServerURL: null, maxAudioChannels: 2 } });
    return () => dispatch({ type: "command", commandName: "unload" });
  }, [open, stream, subtitles]);
  if (!open) return null;
  const close = () => { dispatch({ type: "command", commandName: "unload" }); onClose(); };
  return <div className="player-overlay" role="dialog" aria-modal="true">
    <div className="player-head"><div><small>PŘEHRÁVÁNÍ</small><strong>{title}</strong></div><button className="icon-button" onClick={close}><X /></button></div>
    <div ref={host} className="player-host">{buffering && <div className="player-buffer">Načítám…</div>}{error && <div className="player-error">{error}</div>}</div>
    <div className="timeline"><span>{fmt(time)}</span><input type="range" min="0" max={duration || 1} value={Math.min(time, duration || 1)} onChange={(event) => setProp("time", Number(event.target.value))}/><span>{fmt(duration)}</span></div>
    <div className="player-controls">
      <button onClick={() => setProp("time", Math.max(0, time - 10000))}><RotateCcw/> 10</button>
      <button className="play-toggle" onClick={() => setProp("paused", !paused)}>{paused ? <Play/> : <Pause/>}</button>
      <button onClick={() => setProp("time", Math.min(duration, time + 10000))}>10 <RotateCw/></button>
      <Volume2/><input className="volume" type="range" min="0" max="100" defaultValue="100" onChange={(event) => setProp("volume", Number(event.target.value))}/>
      <button onClick={() => setProp("fullscreen", true)}><Maximize/> Celá obrazovka</button>
    </div>
  </div>;
}

