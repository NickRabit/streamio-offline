import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { StreamItem } from "./types.js";

interface Session { id: string; process: ChildProcess; directory: string; error?: string }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PlaybackManager {
  private sessions = new Map<string, Session>();
  private readonly root: string;
  constructor(dataDir = process.env.DATA_DIR ?? "/data") { this.root = path.join(dataDir, "playback"); }
  async load() { await rm(this.root, { recursive: true, force: true }); await mkdir(this.root, { recursive: true }); }
  async start(stream: StreamItem) {
    if (!stream.url) throw new Error("Tento zdroj nemá přímou adresu pro přehrání.");
    const id = crypto.randomUUID(); const directory = path.join(this.root, id); await mkdir(directory, { recursive: true });
    const params = new URLSearchParams({ url: stream.url }); const headers = stream.behaviorHints?.proxyHeaders?.request ?? {};
    if (Object.keys(headers).length) params.set("headers", Buffer.from(JSON.stringify(headers)).toString("base64url"));
    const input = `http://127.0.0.1:${process.env.PORT ?? 8080}/api/proxy?${params}`;
    const parsed = typeof stream.parsed === "object" && stream.parsed ? stream.parsed as Record<string, unknown> : {}; const codec = String(stream.videoCodec ?? parsed.video_codec ?? "").toLowerCase(); const copyVideo = /h\.?264|avc/.test(codec);
    const args = ["-hide_banner", "-loglevel", "warning", "-nostdin", "-readrate", process.env.FFMPEG_READRATE ?? "1.5", "-i", input, "-map", "0:v:0?", "-map", "0:a:0?", "-map_metadata", "-1", "-c:v", copyVideo ? "copy" : "libx264"];
    if (!copyVideo) args.push("-preset", process.env.FFMPEG_PRESET ?? "veryfast", "-crf", process.env.FFMPEG_CRF ?? "23", "-force_key_frames", "expr:gte(t,n_forced*2)");
    args.push("-c:a", "aac", "-ac", "2", "-b:a", "160k", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "event", "-hls_flags", "independent_segments+temp_file", "-hls_segment_filename", path.join(directory, "segment-%06d.ts"), path.join(directory, "index.m3u8"));
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }); const session: Session = { id, process: child, directory }; this.sessions.set(id, session); let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8000); }); child.once("error", (error) => { session.error = error.message; }); child.once("exit", (code, signal) => { if (code && signal !== "SIGTERM") session.error = stderr.trim() || `FFmpeg skončil s kódem ${code}.`; });
    for (let attempt = 0; attempt < 120; attempt += 1) { try { await access(path.join(directory, "index.m3u8")); return { id, url: `/api/playback/${id}/index.m3u8`, mode: "transcode" as const }; } catch { if (session.error) break; await sleep(250); } }
    await this.stop(id); throw new Error(session.error || "Převod videa se nepodařilo spustit do 30 sekund.");
  }
  async stop(id: string) { const session = this.sessions.get(id); if (!session) return; this.sessions.delete(id); if (!session.process.killed) session.process.kill("SIGTERM"); setTimeout(() => { if (session.process.exitCode == null) session.process.kill("SIGKILL"); }, 3000).unref(); await rm(session.directory, { recursive: true, force: true }); }
  directory(id: string) { return this.sessions.get(id)?.directory; }
}
