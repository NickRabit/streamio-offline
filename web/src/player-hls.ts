/** Shared hls.js options. Remux can run faster than realtime, so a long
 *  forward buffer fills MSE and surfaces bufferFullError. */
export const HLS_PLAYER_CONFIG = {
  maxBufferLength: 25,
  maxMaxBufferLength: 45,
  backBufferLength: 60,
  maxBufferHole: 1,
  maxBufferSize: 40 * 1000 * 1000,
  liveDurationInfinity: true,
  liveSyncDurationCount: 1,
  maxLiveSyncPlaybackRate: 1,
  testBandwidth: false,
};

/** 404s on a generation being replaced are expected. Do not fail the session. */
export const ignoreHlsErrorDuringRestart = (restarting: boolean) => restarting;

/** How far past the current playlist we wait for FFmpeg instead of restarting. */
export const AHEAD_CATCHUP_S = 20;
export const AHEAD_CATCHUP_MS = 8_000;

export type SeekPlan = "native" | "wait" | "restart";

/** Arrow-key skips should not kill FFmpeg: it is already remuxing toward that point. */
export function planSeek(relative: number, playlistEnd: number, aheadSeconds = AHEAD_CATCHUP_S): SeekPlan {
  if (relative < 0) return "restart";
  if (relative <= Math.max(0, playlistEnd - 0.5)) return "native";
  if (relative <= playlistEnd + aheadSeconds) return "wait";
  return "restart";
}

export async function waitForSeekable(
  playlistEnd: () => number,
  relative: number,
  timeoutMs: number,
  cancelled: () => boolean,
  now: () => number = Date.now,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (cancelled()) return false;
    if (relative <= Math.max(0, playlistEnd() - 0.5)) return true;
    await delay(100);
  }
  return relative <= Math.max(0, playlistEnd() - 0.5);
}
