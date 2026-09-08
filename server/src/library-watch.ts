import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { isVideo } from "./library.js";
import { log } from "./logger.js";

export interface LibraryWatch {
  /** False when the platform or the mount gave us no usable watch. */
  active: boolean;
  close(): void;
}

/** Recursive watching is what a network mount is worst at: an SMB or NFS share
 *  delivers no inotify events at all, and Linux has no recursive fs.watch. The
 *  watch is therefore only an accelerator -- the periodic check is what actually
 *  guarantees a copied file is noticed. */
export function watchLibrary(
  dir: string,
  onChange: (file: string) => void,
  { debounceMs = 30_000, timer = setTimeout, clear = clearTimeout }: {
    debounceMs?: number;
    timer?: typeof setTimeout;
    clear?: typeof clearTimeout;
  } = {},
): LibraryWatch {
  let pending: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  let watcher: FSWatcher | undefined;

  const settle = (file: string) => {
    last = file;
    if (pending) clear(pending);
    // A copy lands as a long burst of events, and a half-written file is worth
    // nothing to the scanner, so the run waits for the tree to go quiet.
    pending = timer(() => { pending = undefined; onChange(last); }, debounceMs);
    if (typeof pending === "object" && "unref" in pending) pending.unref();
  };

  try {
    watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
      const name = typeof filename === "string" ? filename : "";
      if (name && !isVideo(name) && path.extname(name)) return;
      settle(name);
    });
    watcher.on("error", (error) => {
      log("INFO", "The library watch stopped, the periodic check takes over", { reason: error instanceof Error ? error.message : String(error) });
      watcher?.close();
      watcher = undefined;
    });
  } catch (error) {
    log("INFO", "The library cannot be watched here, relying on the periodic check", { reason: error instanceof Error ? error.message : String(error) });
    return { active: false, close: () => { if (pending) clear(pending); } };
  }

  return {
    active: true,
    close: () => {
      if (pending) clear(pending);
      watcher?.close();
      watcher = undefined;
    },
  };
}
