import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";
import { completeVttBlocks, shiftVtt, vttCoverage } from "./vtt.js";

type Extract = (args: string[], signal: AbortSignal) => Promise<unknown>;
const extract: Extract = async (args, signal) => {
  // Reading subtitles out of a remote film means pulling the rest of the file through
  // the proxy, which takes minutes on a slow link. Only the abort ends it early; the
  // timeout is a backstop against an FFmpeg that hung instead of finishing.
  const pending = promisify(execFile)("ffmpeg", args, { signal, timeout: 30 * 60_000, killSignal: "SIGKILL" });
  const closed = new Promise<void>((resolve) => pending.child.once("close", () => resolve()));
  try { return await pending; }
  finally { await closed; }
};

/** Cues have to reach this far past the playhead before the track is worth attaching. */
export const SIDECAR_LEAD_S = 120;

interface Job {
  revision: string; track: number; start: number; file: string;
  controller: AbortController; done: Promise<void>; complete: boolean;
  /** How far the cues written so far reach, refreshed whenever the player asks for them. */
  coverage: number;
  served: boolean;
}

export class PlayerSidecars {
  private jobs = new Map<string, Job>();
  constructor(private run: Extract = extract, private failed: (id: string, error: unknown) => void = () => {}) {}

  /** One reader per track: a seek usually lands inside what this one has already written,
   *  and only a position it cannot serve -- another track, a jump back before its start, or
   *  one so far ahead that it would have to read the film to get there -- needs another FFmpeg. */
  ensure(id: string, directory: string, track: number, offset: number, args: (start: number) => Promise<string[]>) {
    const startedAt = Date.now();
    const current = this.jobs.get(id);
    if (current && current.track === track && offset >= current.start && offset <= current.coverage) return;
    const previous = current;
    previous?.controller.abort();
    const revision = randomUUID();
    const start = Math.max(0, offset);
    const job: Job = {
      revision, track, start, file: path.join(directory, `sidecar-${revision}.vtt`),
      controller: new AbortController(), done: Promise.resolve(), complete: false, coverage: -Infinity, served: false,
    };
    this.jobs.set(id, job);
    log("INFO", "Reading embedded subtitles", { id, track, from: Math.round(start) });
    job.done = (async () => {
      try {
        if (previous) { await previous.done; await rm(previous.file, { force: true }).catch(() => undefined); }
        if (job.controller.signal.aborted) return;
        await mkdir(directory, { recursive: true });
        const input = await args(start);
        if (job.controller.signal.aborted) return;
        await this.run([...input, "-y", job.file], job.controller.signal);
        job.complete = !job.controller.signal.aborted;
        if (job.complete) { job.coverage = Infinity; log("INFO", "Embedded subtitles read to the end", { id, track, seconds: Math.round((Date.now() - startedAt) / 1000) }); }
      } catch (error) {
        if (!job.controller.signal.aborted) this.failed(id, error);
      } finally {
        if (!job.complete) await rm(job.file, { force: true }).catch(() => undefined);
      }
    })();
  }

  revision(id: string) { return this.jobs.get(id)?.revision; }

  /** The cues are written with source timestamps, so they are shifted to the playing
   *  generation here rather than extracted again for every position. */
  async read(id: string, revision: string | undefined, offset: number): Promise<{ text: string; complete: boolean } | undefined> {
    const job = this.jobs.get(id);
    if (!job || (revision !== undefined && job.revision !== revision)) return undefined;
    let raw: string;
    try { raw = await readFile(job.file, "utf8"); } catch { return undefined; }
    const text = job.complete ? raw : completeVttBlocks(raw);
    if (!job.complete) {
      job.coverage = vttCoverage(text);
      if (job.coverage < offset + SIDECAR_LEAD_S) {
        // The one line that says why a film is playing without subtitles.
        log("DEBUG", "Embedded subtitles are still behind the picture", { id, wanted: Math.round(offset + SIDECAR_LEAD_S), reached: Math.round(job.coverage) });
        return undefined;
      }
    }
    if (!job.served) { job.served = true; log("INFO", "Embedded subtitles reached the player", { id, track: job.track, complete: job.complete }); }
    const shifted = offset > 0 ? shiftVtt(text, offset) : text;
    return { text: shifted, complete: job.complete };
  }

  async stop(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    job.controller.abort();
    await job.done;
    await rm(job.file, { force: true }).catch(() => undefined);
  }
}
