export const SIDECAR_POLL_MS = 250;
export const SIDECAR_WAIT_MS = 60_000;
export const SIDECAR_REQUEST_MS = 5_000;

/** Safari gained AbortSignal.any only in 17.4, so a per-request timeout that also
 *  follows the caller's cancellation is wired by hand. */
function requestSignal(signal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    settle: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); },
  };
}

/** FFmpeg writes the sidecar while playback is already running, so the track is
 *  attached only once the file answers. */
export async function waitForSidecar(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const deadline = now() + SIDECAR_WAIT_MS;
  while (!signal.aborted && now() < deadline) {
    const request = requestSignal(signal, SIDECAR_REQUEST_MS);
    const response = await fetcher(url, { signal: request.signal }).catch(() => undefined);
    request.settle();
    if (signal.aborted) return false;
    // The element fetches the track itself; this copy of the body is dead weight.
    if (response) void response.body?.cancel().catch(() => undefined);
    if (response?.ok) return true;
    await delay(SIDECAR_POLL_MS);
  }
  return false;
}
