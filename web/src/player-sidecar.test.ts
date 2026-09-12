import { describe, expect, it, vi } from "vitest";
import { SIDECAR_REQUEST_MS, watchSidecar } from "./player-sidecar";

const response = (ok: boolean, complete = false) => ({
  ok, body: null, headers: new Headers(ok ? { "x-sidecar-complete": complete ? "1" : "0" } : {}),
}) as unknown as Response;
const noDelay = () => Promise.resolve();

describe("watchSidecar", () => {
  it("keeps asking while FFmpeg is still reading the film", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(false))
      .mockRejectedValueOnce(new Error("not there yet"))
      .mockResolvedValueOnce(response(true, true));
    const states: unknown[] = [];
    await watchSidecar("/sidecar.vtt", new AbortController().signal, (state) => states.push(state), fetcher, noDelay);
    expect(states).toEqual([{ ready: true, complete: true }]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("attaches the cues that reached the playhead, then the rest when they arrive", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true, true));
    const states: unknown[] = [];
    await watchSidecar("/sidecar.vtt", new AbortController().signal, (state) => states.push(state), fetcher, noDelay);
    // The middle answer says nothing new, so the track is not remounted for it.
    expect(states).toEqual([{ ready: true, complete: false }, { ready: true, complete: true }]);
  });

  it("stops when the player closes or the session changes", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockImplementation(() => { controller.abort(); return Promise.resolve(response(true, true)); });
    const states: unknown[] = [];
    await watchSidecar("/sidecar.vtt", controller.signal, (state) => states.push(state), fetcher, noDelay);
    expect(states).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out a single request without AbortSignal.any, which older Safari lacks", async () => {
    vi.useFakeTimers();
    try {
      const any = vi.spyOn(AbortSignal, "any");
      const signals: AbortSignal[] = [];
      const fetcher = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        signals.push(init!.signal!);
        return new Promise(() => {});
      });
      void watchSidecar("/sidecar.vtt", new AbortController().signal, () => {}, fetcher as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(SIDECAR_REQUEST_MS + 1);
      expect(signals[0].aborted).toBe(true);
      expect(any).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("leaves no pending request timer behind once the track is complete", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue(response(true, true));
      await watchSidecar("/sidecar.vtt", new AbortController().signal, () => {}, fetcher);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
