import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

type Extract = (args: string[], signal: AbortSignal) => Promise<unknown>;
const extract: Extract = (args, signal) => promisify(execFile)("ffmpeg", args, { signal, timeout: 45_000, killSignal: "SIGKILL" });
interface Job { revision: string; file: string; controller: AbortController; done: Promise<void>; ready: boolean }

export class PlayerSidecars {
  private jobs = new Map<string, Job>();
  constructor(private run: Extract = extract, private failed: (id: string, error: unknown) => void = () => {}) {}

  start(id: string, directory: string, args: () => Promise<string[]>) {
    const previous = this.jobs.get(id);
    previous?.controller.abort();
    const revision = randomUUID();
    const job: Job = { revision, file: path.join(directory, `sidecar-${revision}.vtt`), controller: new AbortController(), done: Promise.resolve(), ready: false };
    this.jobs.set(id, job);
    job.done = (async () => {
      try {
        if (previous) { await previous.done; await rm(previous.file, { force: true }); }
        if (job.controller.signal.aborted) return;
        await mkdir(directory, { recursive: true });
        const input = await args();
        if (job.controller.signal.aborted) return;
        await this.run([...input, "-y", job.file], job.controller.signal);
        job.ready = !job.controller.signal.aborted && this.jobs.get(id) === job;
      } catch (error) {
        if (!job.controller.signal.aborted) this.failed(id, error);
      } finally {
        if (!job.ready) await rm(job.file, { force: true }).catch(() => undefined);
      }
    })();
  }

  revision(id: string) { return this.jobs.get(id)?.revision; }
  file(id: string, revision?: string) {
    const job = this.jobs.get(id);
    return job?.ready && (!revision || job.revision === revision) ? job.file : undefined;
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
