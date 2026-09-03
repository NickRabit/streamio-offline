import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { INTERNAL_TOKEN } from "./auth.js";
import { log } from "./logger.js";
import { pickByLanguage } from "./language.js";
import { probe, type MediaInfo, type Track } from "./probe.js";
import type { StreamItem } from "./types.js";

/** direct = prohlížeč hraje soubor rovnou, remux = přebalení bez překódování videa, transcode = skutečný převod. */
export type PlaybackMode = "direct" | "remux" | "transcode";

export interface ClientCapabilities {
  h264?: boolean; hevc?: boolean; hevc10?: boolean; vp8?: boolean; vp9?: boolean; av1?: boolean;
  aac?: boolean; mp3?: boolean; opus?: boolean; vorbis?: boolean; ac3?: boolean; eac3?: boolean; flac?: boolean;
}

export interface PlaybackOptions {
  audioLanguage?: string;
  subtitleLanguage?: string;
  audioTrack?: number;
  subtitleTrack?: number | null;
  startTime?: number;
  /** Maximální výška obrazu; null nebo undefined = originál bez zásahu do videa. */
  quality?: number | null;
}

export interface PlaybackDescriptor {
  id: string; mode: PlaybackMode; url: string; offset: number;
  duration?: number; video?: string; audio?: string; hardware: boolean;
  /** Zda server umí překódovat s hardwarovou akcelerací; v režimu remux se nepoužívá. */
  acceleration: boolean;
  audioTracks: Track[]; subtitleTracks: Track[];
  audioTrack: number; subtitleTrack: number | null;
  quality: number | null;
}

/** Povolené cílové kvality a strop datového toku videa pro každou z nich. */
export const QUALITY_BITRATE: Record<number, string> = { 1080: "6M", 720: "3M", 480: "1500k" };

/** Jednoduchá fronta operací pro jednu relaci. Seek a změna stopy nesmějí
 * běžet souběžně, protože každý restart vytváří a uklízí vlastní HLS generaci. */
export class SerialOperations {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  wait() { return this.tail; }
}

interface Session {
  id: string; stream: StreamItem; capabilities: ClientCapabilities; info?: MediaInfo;
  mode: PlaybackMode; generation: number; offset: number; hardware: boolean;
  audioTrack: number; subtitleTrack: number | null; quality: number | null;
  process?: ChildProcess; directory?: string; error?: string; lastAccess: number; pendingKill?: Promise<void>;
  operations: SerialOperations; stopped: boolean;
}

/** Main a Main 10 jsou pro prohlížeč dva různé kodeky. Desetibitový stream se nesmí kopírovat
 *  jen proto, že prohlížeč umí osmibitový — SourceBuffer by ho odmítl (bufferAddCodecError). */
const hevcPlayable = (video: MediaInfo["video"], caps: ClientCapabilities) => {
  const deep = /\b1[02]\b/.test(video?.profile ?? "") || /p1[02](le|be)$/i.test(video?.pixelFormat ?? "");
  return deep ? caps.hevc10 === true : caps.hevc === true;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DIRECT_MP4 = new Set([".mp4", ".m4v", ".mov"]);
const COPYABLE_AUDIO: Record<string, keyof ClientCapabilities> = { aac: "aac", mp3: "mp3", opus: "opus", ac3: "ac3", eac3: "eac3", flac: "flac" };
const IDLE_MS = 5 * 60_000;

/** Do logu ani k uživateli nesmí prosáknout adresa zdroje — bývá v ní token doplňku. */
const redact = (text: string) => text.replace(/https?:\/\/\S+/g, "<zdroj>");
const NOISE = /you should use tag|deprecated|Last message repeated|^\s*$/i;
const describeFailure = (stderr: string, code: number | null) => {
  const lines = redact(stderr).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !NOISE.test(line));
  return lines.length ? lines.slice(-2).join(" ") : `FFmpeg skončil s kódem ${code}.`;
};

export class PlaybackManager {
  private sessions = new Map<string, Session>();
  private inspected = new Map<string, { info?: MediaInfo; at: number }>();
  private readonly root: string;
  private vaapiDevice?: string;
  /** Some chips decode and encode but have no video processing unit, so scale_vaapi fails. */
  private vaapiScaling = true;
  /** Some drivers only offer constant quality, so a target bitrate makes the encoder refuse to open. */
  private vaapiBitrate = true;
  private vaapiFailures = 0;
  /** -readrate_initial_burst existuje až od FFmpeg 6; starší verzi by volba shodila. */
  private initialBurst = false;

  constructor(dataDir = process.env.DATA_DIR ?? "/data") { this.root = path.join(dataDir, "playback"); }

  async load() {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
    try {
      const { stdout } = await promisify(execFile)("ffmpeg", ["-version"], { timeout: 10_000 });
      const major = Number(/version\s+n?(\d+)[.\s-]/.exec(stdout)?.[1]);
      this.initialBurst = major >= 6;
      if (!this.initialBurst) log("WARN", "FFmpeg je starší než 6, start a posun budou brzděné omezenou rychlostí čtení", { major });
    } catch { log("WARN", "Verzi FFmpeg se nepodařilo zjistit"); }
    const device = process.env.VAAPI_DEVICE;
    if (device) await this.checkVaapi(device);
    setInterval(() => {
      for (const session of [...this.sessions.values()]) {
        if (Date.now() - session.lastAccess > IDLE_MS) { log("INFO", "Nečinná relace ukončena", { id: session.id }); void this.stop(session.id); }
      }
    }, 60_000).unref();
  }

  /** Zjistí stopy zdroje bez spuštění přehrávání; výsledek chvíli držíme, ať se zdroj neotravuje. */
  async inspect(stream: StreamItem): Promise<MediaInfo | undefined> {
    if (!stream.url) throw new Error("Tento zdroj nemá přímou adresu pro přehrání.");
    const cached = this.inspected.get(stream.url);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.info;
    const info = await probe(this.localUrl(this.proxyPath(stream)));
    log(info ? "INFO" : "WARN", info ? "Zdroj rozebrán" : "Zdroj se nepodařilo rozebrat", {
      video: info?.video?.codec, duration: info?.duration ? Math.round(info.duration) : undefined,
      audio: info?.audioTracks.map((track) => `${track.codec}/${track.language ?? "?"}${track.title ? `/${track.title}` : ""}`),
      subtitles: info?.subtitleTracks.map((track) => `${track.codec}/${track.language ?? "?"}${track.title ? `/${track.title}` : ""}`),
    });
    if (this.inspected.size > 200) this.inspected.clear();
    this.inspected.set(stream.url, { info, at: Date.now() });
    return info;
  }

  async start(stream: StreamItem, capabilities: ClientCapabilities = {}, options: PlaybackOptions = {}): Promise<PlaybackDescriptor> {
    if (!stream.url) throw new Error("Tento zdroj nemá přímou adresu pro přehrání.");
    const id = crypto.randomUUID();
    const source = this.proxyPath(stream);
    // Přes inspect(), ať se seznam zdrojů a přehrávač nikdy nerozejdou v tom, co soubor obsahuje.
    const info = await this.inspect(stream);
    const audioTracks = info?.audioTracks ?? [];
    const subtitleTracks = info?.subtitleTracks ?? [];

    const audioTrack = options.audioTrack ?? Math.max(0, pickByLanguage(audioTracks, options.audioLanguage));
    const subtitleTrack = options.subtitleTrack !== undefined
      ? options.subtitleTrack
      : this.preferredSubtitle(subtitleTracks, options.subtitleLanguage);

    const quality = options.quality != null && QUALITY_BITRATE[options.quality] ? options.quality : null;
    const session: Session = {
      id, stream, capabilities, info, mode: "direct", generation: 0, offset: 0, hardware: false,
      audioTrack, subtitleTrack, quality, lastAccess: Date.now(), operations: new SerialOperations(), stopped: false,
    };
    this.sessions.set(id, session);
    const summary = { video: info?.video?.codec, audio: info?.audio?.codec, audioTracks: audioTracks.length, subtitleTracks: subtitleTracks.length };

    // Přímé přehrání dává smysl jen u výchozích stop a originální kvality; jinak musí zasáhnout FFmpeg.
    if (audioTrack === 0 && subtitleTrack === null && quality === null && this.canDirectPlay(stream, info, capabilities)) {
      log("INFO", "Přehrávání přímo ze zdroje", { id, ...summary });
      return this.describe(session, source);
    }

    session.mode = this.plan(session).copyVideo ? "remux" : "transcode";
    try {
      const limit = info?.duration ? Math.max(0, info.duration - 2) : Number.POSITIVE_INFINITY;
      const startTime = Math.max(0, Math.min(options.startTime ?? 0, limit));
      const url = await this.spawnAt(session, startTime);
      log("INFO", "Převod spuštěn", { id, mode: session.mode, hardware: session.hardware, audioTrack, subtitleTrack, ...summary });
      return this.describe(session, url);
    } catch (error) { await this.stop(id); throw error; }
  }

  /** Posun mimo už vyrobenou část: FFmpeg se restartuje od nové pozice, klient si posune časovou osu. */
  async seek(id: string, time: number) {
    const session = this.require(id);
    return session.operations.run(() => this.restart(session, time, "Posun v přehrávání"));
  }

  /** Přepnutí stopy nebo kvality znamená nové mapování či filtry, tedy restart od aktuální pozice. */
  async track(id: string, changes: { audio?: number; subtitle?: number | null; quality?: number | null; time?: number }) {
    const session = this.require(id);
    return session.operations.run(async () => {
      this.assertActive(session);
      if (changes.audio !== undefined) session.audioTrack = Math.max(0, changes.audio);
      if (changes.subtitle !== undefined) session.subtitleTrack = changes.subtitle;
      if (changes.quality !== undefined) session.quality = changes.quality != null && QUALITY_BITRATE[changes.quality] ? changes.quality : null;
      // Návrat na originál může znovu splnit podmínky přímého přehrání.
      if (session.quality === null && session.audioTrack === 0 && session.subtitleTrack === null
        && this.canDirectPlay(session.stream, session.info, session.capabilities)) {
        session.pendingKill = this.kill(session);
        session.mode = "direct"; session.offset = 0;
        log("INFO", "Návrat k přímému přehrávání", { id });
        return this.describe(session, this.proxyPath(session.stream));
      }
      return this.restart(session, changes.time ?? session.offset, "Přepnuta stopa");
    });
  }

  private async restart(session: Session, time: number, message: string) {
    this.assertActive(session);
    const id = session.id;
    const limit = session.info?.duration ? Math.max(0, session.info.duration - 2) : Number.POSITIVE_INFINITY;
    const target = Math.max(0, Math.min(time, limit));
    // Starý FFmpeg dobíhá na pozadí; nový píše do jiné generace, takže se nemají o co přetahovat.
    session.pendingKill = this.kill(session);
    if (session.mode === "direct") session.mode = this.plan(session).copyVideo ? "remux" : "transcode";
    let url: string;
    try { url = await this.spawnAt(session, target); }
    catch (error) {
      this.assertActive(session);
      log("WARN", "Restart převodu selhal, zkouším ještě jednou", { id, offset: Math.round(target), reason: error instanceof Error ? error.message : String(error) });
      await sleep(1000);
      this.assertActive(session);
      url = await this.spawnAt(session, target);
    }
    // Whether the restart ended up on the GPU is worth knowing: a transcode that says
    // nothing looks the same in the log as one that quietly fell back to the processor.
    log("INFO", message, { id, offset: Math.round(target), mode: session.mode, hardware: session.hardware, audioTrack: session.audioTrack, subtitleTrack: session.subtitleTrack });
    return this.describe(session, url);
  }

  async stop(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.stopped = true;
    this.sessions.delete(id);
    await this.kill(session);
    await session.operations.wait();
    await this.kill(session);
    await this.purge(path.join(this.root, id));
  }

  directory(id: string, generation: string) {
    const session = this.sessions.get(id);
    if (!session || String(session.generation) !== generation) return undefined;
    session.lastAccess = Date.now();
    return session.directory;
  }

  private require(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.stopped) throw new Error("Relace přehrávání už neexistuje.");
    return session;
  }

  private assertActive(session: Session) {
    if (session.stopped || this.sessions.get(session.id) !== session) throw new Error("Relace přehrávání už neexistuje.");
  }

  private describe(session: Session, url: string): PlaybackDescriptor {
    return {
      id: session.id, mode: session.mode, url, offset: session.offset,
      duration: session.info?.duration, video: session.info?.video?.codec, audio: session.info?.audio?.codec,
      hardware: session.hardware, acceleration: Boolean(this.vaapiDevice),
      audioTracks: session.info?.audioTracks ?? [], subtitleTracks: session.info?.subtitleTracks ?? [],
      audioTrack: session.audioTrack, subtitleTrack: session.subtitleTrack, quality: session.quality,
    };
  }

  /** Vestavěné titulky zapínáme samy od sebe jen tehdy, když opravdu sedí preferovaný jazyk. */
  private preferredSubtitle(tracks: Track[], preferred?: string): number | null {
    if (!tracks.length || !preferred) return null;
    const match = tracks.findIndex((track) => track.language === preferred);
    return match >= 0 ? match : null;
  }

  private proxyPath(stream: StreamItem) {
    // Stažený soubor nechodí přes proxy, servíruje ho knihovna přímo z disku.
    if (stream.url!.startsWith("file://")) return `/api/library/file?path=${encodeURIComponent(stream.url!.slice(7))}`;
    const params = new URLSearchParams({ url: stream.url! });
    const headers = stream.behaviorHints?.proxyHeaders?.request ?? {};
    if (Object.keys(headers).length) params.set("headers", Buffer.from(JSON.stringify(headers)).toString("base64url"));
    return `/api/proxy?${params}`;
  }
  /** Volání zevnitř serveru se prokazuje procesním tokenem, protože cookie prohlížeče nemá. */
  private localUrl(relative: string) {
    return `http://127.0.0.1:${process.env.PORT ?? 8080}${relative}${relative.includes("?") ? "&" : "?"}token=${INTERNAL_TOKEN}`;
  }

  private extension(stream: StreamItem) {
    let name = stream.behaviorHints?.filename ?? "";
    if (!name) { try { name = new URL(stream.url!).pathname; } catch { name = ""; } }
    return path.extname(name).toLowerCase();
  }

  /** Nejlevnější cesta: soubor, který prohlížeč zvládne sám. Seek pak jede nativně přes HTTP Range. */
  private canDirectPlay(stream: StreamItem, info: MediaInfo | undefined, caps: ClientCapabilities) {
    if (stream.behaviorHints?.notWebReady || !info?.video) return false;
    const extension = this.extension(stream);
    const video = info.video.codec;
    const audio = info.audio?.codec;
    if (DIRECT_MP4.has(extension)) {
      const videoOk = video === "h264" || (video === "hevc" && hevcPlayable(info.video, caps));
      return videoOk && (!audio || audio === "aac" || audio === "mp3");
    }
    if (extension === ".webm") {
      const videoOk = video === "vp8" || video === "vp9" || (video === "av1" && caps.av1 === true);
      return videoOk && (!audio || audio === "opus" || audio === "vorbis");
    }
    return false;
  }

  /** Že zařízení existuje a jde otevřít ještě neznamená, že se přes něj dá kódovat:
   * na některých sestavách libva selže až při vytváření kontextu. Zkusíme proto
   * rovnou zakódovat jeden drobný snímek a řídíme se výsledkem, ne dohadem --
   * jinak by každé přehrávání platilo několikasekundový pokus, který stejně spadne. */
  private async checkVaapi(device: string) {
    try { await access(device, constants.R_OK | constants.W_OK); }
    catch {
      // Report which group actually owns the device and which ones the process holds:
      // otherwise finding the right RENDER_GID means a trip to the container terminal.
      let owner: number | undefined;
      try { owner = (await stat(device)).gid; } catch { /* device may be gone entirely */ }
      log("WARN", "K VAAPI_DEVICE nemáme přístup, převod poběží softwarově. Nastavte v .env RENDER_GID na hodnotu deviceGroup", {
        device,
        deviceGroup: owner,
        ourGroups: process.getgroups?.() ?? [],
        runningAs: `${process.getuid?.()}:${process.getgid?.()}`,
      });
      return;
    }
    try {
      await this.runVaapiProbe(device, "format=nv12,hwupload");
      this.vaapiDevice = device;
      // Encoding working says nothing about scaling: the video processing unit is a
      // separate piece and DSM chips often lack it. Probing the encoder alone would
      // let playback fail later with "the requested VAProfile is not supported".
      this.vaapiScaling = await this.probeVaapi(device, "format=nv12,hwupload,scale_vaapi=w=128:h=72:format=nv12");
      this.vaapiBitrate = await this.probeVaapi(device, "format=nv12,hwupload", ["-b:v", "1M", "-maxrate", "1M"]);
      log("INFO", "VAAPI je k dispozici", { device, gpuScaling: this.vaapiScaling, bitrateControl: this.vaapiBitrate });
      if (!this.vaapiScaling) log("INFO", "GPU neumí škálovat, zmenšení obrazu poběží na procesoru", { device });
      if (!this.vaapiBitrate) log("INFO", "GPU neumí cílový datový tok, kóduje se na konstantní kvalitu", { device });
    } catch (error) {
      const output = (error as { stderr?: string }).stderr ?? String(error);
      const reason = output.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "neznámá chyba";
      log("WARN", "VAAPI nefunguje, převod poběží softwarově. Zkuste v .env nastavit LIBVA_DRIVER_NAME=iHD nebo i965; podrobnosti vypíše vainfo v terminálu kontejneru", { device, reason });
    }
  }

  private async runVaapiProbe(device: string, filters: string, encoder: string[] = []) {
    await promisify(execFile)("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-init_hw_device", `vaapi=va:${device}`, "-filter_hw_device", "va",
      "-f", "lavfi", "-i", "nullsrc=s=256x144:d=0.1",
      "-vf", filters, "-c:v", "h264_vaapi", ...encoder, "-f", "null", "-",
    ], { timeout: 30_000 });
  }

  private async probeVaapi(device: string, filters: string, encoder: string[] = []) {
    try { await this.runVaapiProbe(device, filters, encoder); return true; }
    catch { return false; }
  }

  /** Emby tomu říká Direct Stream: kontejner se přebalí, video se jen kopíruje. */
  private plan(session: Session) {
    const caps = session.capabilities;
    const video = session.info?.video?.codec ?? "";
    const audio = session.info?.audioTracks?.[session.audioTrack]?.codec ?? session.info?.audio?.codec ?? "";
    // Zvolená nižší kvalita vynucuje skutečné překódování; kopie by nesla původní rozlišení.
    const copyVideo = session.quality === null
      && ((video === "h264" && caps.h264 !== false) || (video === "hevc" && hevcPlayable(session.info?.video, caps)));
    const audioCapability = COPYABLE_AUDIO[audio];
    return { copyVideo, copyAudio: Boolean(audioCapability && caps[audioCapability] === true) };
  }

  private async spawnAt(session: Session, offset: number): Promise<string> {
    this.assertActive(session);
    const previous = session.directory;
    session.generation += 1;
    session.offset = offset;
    const directory = path.join(this.root, session.id, String(session.generation));
    await mkdir(directory, { recursive: true });
    this.assertActive(session);
    session.directory = directory;
    session.lastAccess = Date.now();
    // Uklidit se dá až po skutečném konci starého procesu, jinak si sahají do stejného adresáře.
    if (previous) void (session.pendingKill ?? Promise.resolve()).then(() => this.purge(previous));

    const { copyVideo } = this.plan(session);
    session.mode = copyVideo ? "remux" : "transcode";
    const attempts = !copyVideo && this.vaapiDevice ? [true, false] : [false];
    for (const hardware of attempts) {
      this.assertActive(session);
      const url = await this.run(session, offset, directory, hardware);
      if (url) return url;
      if (hardware) {
        log("WARN", "VAAPI selhalo, zkouším softwarový převod", { id: session.id, reason: session.error });
        // A driver that refuses twice will refuse every time, and each attempt costs the
        // viewer about twenty seconds before playback starts. Stop offering it.
        this.vaapiFailures += 1;
        if (this.vaapiFailures >= 2) {
          this.vaapiDevice = undefined;
          log("WARN", "VAAPI opakovaně selhalo, do restartu se používat nebude", { failures: this.vaapiFailures });
        }
      }
    }
    throw new Error(session.error || "Převod videa se nepodařilo spustit.");
  }

  private async run(session: Session, offset: number, directory: string, hardware: boolean) {
    const args = this.args(session, offset, directory, hardware);
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    session.process = child; session.hardware = hardware; session.error = undefined;
    let stderr = ""; let finished = false; let exitCode: number | null = null;
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    child.once("error", (error) => { finished = true; session.error = error.message; });
    // Až 'close' zaručuje, že je stderr přečtený; 'exit' poslední hlášku běžně nestihne.
    child.once("close", (code, signal) => { finished = true; exitCode = code; if (code !== 0 && signal === null) session.error = describeFailure(stderr, code); });

    // Master vzniká hned v hlavičce, ale variantní playlist až s prvním segmentem.
    const ready = path.join(directory, "index-0.m3u8");
    const url = `/api/playback/${session.id}/${session.generation}/master.m3u8`;
    // S jediným segmentem v playlistu hls.js přehraje pár sekund a čeká na obnovení playlistu —
    // to je to bliknutí „Načítám“ chvíli po startu či posunu. Díky burst čtení bývá druhý
    // segment hotový hned, tak na něj krátce počkáme; déle než 4 s kvůli tomu start nezdržujeme.
    let firstSegmentAt: number | undefined;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (session.stopped) { child.kill("SIGTERM"); break; }
      try {
        const playlist = await readFile(ready, "utf8");
        const segments = (playlist.match(/#EXTINF/g) ?? []).length;
        if (segments >= 2 || playlist.includes("#EXT-X-ENDLIST")) return url;
        if (segments >= 1) {
          if (finished) return url;
          firstSegmentAt ??= Date.now();
          if (Date.now() - firstSegmentAt > 4000) return url;
        }
      } catch { /* playlist ještě neexistuje */ }
      if (finished) break;
      await sleep(100);
    }
    if (!finished) { child.kill("SIGKILL"); session.error ||= "Převod se nerozeběhl do 40 sekund."; }
    session.error ||= describeFailure(stderr, exitCode);
    log("ERROR", "Převod se nepodařilo spustit", {
      id: session.id, offset: Math.round(offset), mode: session.mode, hardware, exitCode,
      audioTrack: session.audioTrack, subtitleTrack: session.subtitleTrack,
      reason: session.error,
      args: args.map((value) => value.startsWith("http") ? "<zdroj>" : value).join(" "),
      stderr: redact(stderr).slice(-1500),
    });
    return undefined;
  }

  private args(session: Session, offset: number, directory: string, hardware: boolean) {
    const { copyVideo, copyAudio } = this.plan(session);
    const quality = session.quality;
    const bitrate = quality !== null ? QUALITY_BITRATE[quality] : undefined;
    const sourceVideo = session.info?.video?.codec ?? "";
    // Mapování a var_stream_map musí přesně sedět na to, co soubor opravdu má. Otazník v -map
    // chybějící stopu potichu vypustí, jenže hls muxer ji pak marně hledá a spadne na hlavičce.
    const audioCount = session.info?.audioTracks.length ?? 1;
    const hasAudio = !session.info || audioCount > 0;
    const audioIndex = Math.min(session.audioTrack, Math.max(0, audioCount - 1));
    const subtitleCount = session.info?.subtitleTracks.length ?? 0;
    const subtitle = session.subtitleTrack !== null && session.subtitleTrack < subtitleCount ? session.subtitleTrack : null;
    const crf = process.env.FFMPEG_CRF ?? "23";
    // VAAPI CQP a libx264 CRF jsou odlišné režimy. Zpětná kompatibilita s jedinou
    // původní hodnotou zůstává, ale nové instalace je mohou ladit nezávisle.
    const vaapiQp = process.env.VAAPI_QP ?? crf;
    const args = ["-hide_banner", "-loglevel", "warning", "-nostdin"];
    // -ss před -i seekuje přes HTTP Range, takže se nepřenáší nic před požadovanou pozicí.
    // U kopie videa musí i zvuk začít na klíčovém snímku (noaccurate_seek): přesný ořez zvuku
    // by nechal video napřed a vzniklou díru ve zvuku přehrávač řeší rozjetou synchronizací.
    if (offset > 0) {
      if (copyVideo) args.push("-noaccurate_seek");
      args.push("-ss", offset.toFixed(3));
    }
    // Když funguje VAAPI video processing, můžeme nechat dekódování, scaling i encoding
    // na GPU. Slabší Intel GPU v Synology ale často umí jen encoder. V takovém případě
    // nedáváme FFmpegu -hwaccel: dekóduje a škáluje v RAM a explicitně inicializované
    // zařízení použije až hwupload + h264_vaapi. Vyhneme se tak problematickému převodu
    // VAAPI surfaces zpět do systémové paměti.
    if (!copyVideo && hardware) {
      if (this.vaapiScaling) {
        args.push("-hwaccel", "vaapi", "-hwaccel_device", this.vaapiDevice!, "-hwaccel_output_format", "vaapi");
      } else {
        args.push("-init_hw_device", `vaapi=va:${this.vaapiDevice!}`, "-filter_hw_device", "va");
      }
    }
    // Náskok se platí zápisem na disk: při přebalení 8x rychleji než reálný čas nasype
    // FFmpeg ~340 MB za 20 s a slabší NAS se zadusí protlačováním špinavých stránek.
    // Trojka drží posun stejně svižný (rozhoduje počáteční nával), ale zápis je třetinový.
    args.push("-readrate", copyVideo ? process.env.FFMPEG_READRATE_REMUX ?? "3" : process.env.FFMPEG_READRATE ?? "1.5");
    // Prvních pár desítek sekund se čte plnou rychlostí, ať je první segment hotový co nejdřív;
    // teprve potom nastoupí brzda proti zbytečnému stahování celého souboru.
    if (this.initialBurst) args.push("-readrate_initial_burst", process.env.FFMPEG_BURST ?? "30");
    args.push("-i", this.localUrl(this.proxyPath(session.stream)));
    args.push("-map", "0:v:0?");
    if (hasAudio) args.push("-map", `0:a:${audioIndex}?`);
    if (subtitle !== null) args.push("-map", `0:s:${subtitle}?`);
    args.push("-map_metadata", "-1", "-map_chapters", "-1", "-dn");
    // Kopie videa po -ss začíná na klíčovém snímku před cílem, takže má záporné časové značky.
    // fMP4 je neumí zapsat a posouval by každou stopu zvlášť — zvuk by se rozjel o vzdálenost
    // ke klíčovému snímku. make_zero posune všechny stopy stejně a synchronizaci zachová.
    args.push("-avoid_negative_ts", "make_zero");

    if (copyVideo) {
      args.push("-c:v", "copy");
      // Safari přehraje HEVC v fMP4 jen pod tagem hvc1, s výchozím hev1 stream odmítne.
      if (sourceVideo === "hevc") args.push("-tag:v", "hvc1");
    }
    // Klíčový snímek každé 2 s drží segmenty krátké: HLS smí řezat jen na klíčových snímcích,
    // takže delší GOP by protahoval čekání na první segment po startu i po každém posunu.
    // min(kvalita, ih) zabrání zvětšování obrazu, když je zdroj menší než zvolená kvalita.
    else if (hardware) {
      const resize = quality !== null ? `w=-2:h=min(${quality}\\,ih)` : "";
      const filters = this.vaapiScaling
        ? (quality !== null ? `scale_vaapi=${resize}:format=nv12` : "scale_vaapi=format=nv12")
        // Scaling on the processor is still far cheaper than encoding, so the encoder stays on the GPU.
        : (quality !== null ? `scale=${resize},format=nv12,hwupload` : "format=nv12,hwupload");
      args.push("-vf", filters, "-c:v", "h264_vaapi");
      if (bitrate && this.vaapiBitrate) args.push("-b:v", bitrate, "-maxrate", bitrate);
      else args.push("-qp", vaapiQp);
      args.push("-g", "48", "-force_key_frames", "expr:gte(t,n_forced*2)");
    } else {
      if (quality !== null) args.push("-vf", `scale=-2:min(${quality}\\,ih)`);
      args.push("-c:v", "libx264", "-preset", process.env.FFMPEG_PRESET ?? "veryfast", "-crf", crf, "-pix_fmt", "yuv420p", "-force_key_frames", "expr:gte(t,n_forced*2)");
      if (bitrate) args.push("-maxrate", bitrate, "-bufsize", bitrate);
    }
    // Audio passthrough má smysl jen u remuxu. Při transkódování obrazu může zejména
    // kopírované E-AC-3 zablokovat inicializaci fMP4 HLS ("codec frame size is not set").
    // AAC je pro webové klienty nejspolehlivější a jeho převod zatěžuje NAS minimálně.
    const passthroughAudio = copyVideo && copyAudio;
    if (hasAudio) args.push(...(passthroughAudio ? ["-c:a", "copy"] : ["-c:a", "aac", "-ac", "2", "-b:a", "160k"]));
    if (subtitle !== null) args.push("-c:s", "webvtt");

    // fMP4 segmenty: jediný způsob, jak propustit HEVC nebo AC3 bez překódování.
    // Vestavěné titulky jdou ven jako vlastní WebVTT stopa ze stejného průchodu, bez druhého stažení.
    args.push("-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "event",
      "-hls_segment_type", "fmp4", "-hls_flags", "independent_segments+temp_file", "-hls_fmp4_init_filename", "init.mp4",
      "-master_pl_name", "master.m3u8",
      "-var_stream_map", [hasAudio ? "v:0,a:0" : "v:0", subtitle !== null ? ",s:0,sgroup:subs" : ""].join(""),
      "-hls_segment_filename", path.join(directory, "seg-%v-%06d.m4s"), path.join(directory, "index-%v.m3u8"));
    return args;
  }

  /** Čeká na skutečný konec procesu: dokud FFmpeg žije, zapisuje segmenty a adresář nejde smazat. */
  private kill(session: Session): Promise<void> {
    const child = session.process;
    session.process = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      const giveUp = setTimeout(() => resolve(), 6000);
      child.once("exit", () => { clearTimeout(force); clearTimeout(giveUp); resolve(); });
      child.kill("SIGTERM");
    });
  }

  private async purge(directory: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch { await sleep(200); }
    }
    log("WARN", "Adresář relace se nepodařilo uklidit", { directory });
  }
}
