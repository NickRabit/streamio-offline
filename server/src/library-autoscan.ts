import { libraryFingerprint, type FoundFile } from "./library.js";
import { log } from "./logger.js";
import type { ScanState } from "./library-scan.js";

export type AutoScanReason = "startup" | "interval" | "watch";

export interface LibraryAutoScanOpts {
  enabled: () => boolean;
  files: () => Promise<FoundFile[]>;
  status: () => ScanState;
  start: () => Promise<ScanState>;
  /** Playback or a running download; the scan would only pause itself anyway. */
  busy: () => boolean;
  watch?: (onChange: () => void) => { active: boolean; close(): void };
  intervalMs?: number;
  startupDelayMs?: number;
}

/** Copying a file into the download folder is the one way a title arrives without
 *  the queue knowing about it. The periodic check is the reliable half, the watch
 *  only makes it prompt where the filesystem reports changes at all. */
export class LibraryAutoScan {
  private fingerprint: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private watching: { active: boolean; close(): void } | undefined;
  private running = false;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;

  constructor(private readonly opts: LibraryAutoScanOpts) {
    this.intervalMs = opts.intervalMs ?? 6 * 60 * 60_000;
    this.startupDelayMs = opts.startupDelayMs ?? 2 * 60_000;
  }

  start() {
    if (this.timer) return;
    this.startupTimer = setTimeout(() => { void this.check("startup"); }, this.startupDelayMs);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => { void this.check("interval"); }, this.intervalMs);
    this.timer.unref?.();
    this.watching = this.opts.watch?.(() => { void this.check("watch"); });
    log("INFO", "Automatic library scan armed", { intervalMs: this.intervalMs, watching: Boolean(this.watching?.active) });
  }

  stop() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = undefined;
    this.timer = undefined;
    this.watching?.close();
    this.watching = undefined;
  }

  /** A manual scan covers the same ground, so its result becomes our baseline too. */
  async remember() {
    this.fingerprint = libraryFingerprint(await this.opts.files());
  }

  isWatching() { return Boolean(this.watching?.active); }

  async check(reason: AutoScanReason): Promise<boolean> {
    if (this.running || !this.opts.enabled()) return false;
    const status = this.opts.status().status;
    if (status === "running" || status === "paused") return false;
    // Nothing is gained by starting while the disk and the line are busy; the scan
    // would pause on its own and the next check picks it up.
    if (this.opts.busy()) return false;
    this.running = true;
    try {
      const stamp = libraryFingerprint(await this.opts.files());
      // The first check after a restart has no baseline: files may have been copied
      // in while the server was down, and a scan with nothing new to do is free.
      if (this.fingerprint === stamp) return false;
      const state = await this.opts.start();
      // Recorded only once the scan is under way, so a start that failed on a
      // sleeping addon is tried again at the next check.
      this.fingerprint = stamp;
      log("INFO", "Automatic library scan started", { reason, total: state.total });
      return true;
    } catch (error) {
      log("WARN", "The automatic library scan could not start", { reason: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      this.running = false;
    }
  }
}
