export const SIDECAR_POLL_MS = 250;
export const SIDECAR_SETTLED_POLL_MS = 5_000;
export const SIDECAR_REQUEST_MS = 15_000;

export interface SidecarState { ready: boolean; complete: boolean }

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

/** Reading subtitles out of a remote film takes as long as the source needs, so the
 *  player waits for the whole session instead of giving up on a deadline: first for
 *  cues to reach the playhead, then for the rest of the track behind them. */
export async function watchSidecar(
  url: string,
  signal: AbortSignal,
  onState: (state: SidecarState) => void,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  let ready = false;
  while (!signal.aborted) {
    const request = requestSignal(signal, SIDECAR_REQUEST_MS);
    const response = await fetcher(url, { signal: request.signal }).catch(() => undefined);
    request.settle();
    if (signal.aborted) return;
    // The element fetches the track itself; this copy of the body is dead weight.
    if (response) void response.body?.cancel().catch(() => undefined);
    if (response?.ok) {
      const complete = response.headers.get("x-sidecar-complete") === "1";
      if (!ready || complete) onState({ ready: true, complete });
      ready = true;
      if (complete) return;
    }
    await delay(ready ? SIDECAR_SETTLED_POLL_MS : SIDECAR_POLL_MS);
  }
}
