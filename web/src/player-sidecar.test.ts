import { describe, expect, it, vi } from "vitest";
import { SIDECAR_REQUEST_MS, SIDECAR_WAIT_MS, waitForSidecar } from "./player-sidecar";

const response = (ok: boolean) => ({ ok, body: null }) as unknown as Response;
const noDelay = () => Promise.resolve();

describe("waitForSidecar", () => {
  it("keeps asking until FFmpeg has written the file", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(false))
      .mockRejectedValueOnce(new Error("not there yet"))
      .mockResolvedValueOnce(response(true));
    await expect(waitForSidecar("/sidecar.vtt", new AbortController().signal, fetcher, Date.now, noDelay)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("gives up at the deadline instead of polling for the whole session", async () => {
    let clock = 0;
    const fetcher = vi.fn().mockResolvedValue(response(false));
    const waiting = waitForSidecar("/sidecar.vtt", new AbortController().signal, fetcher, () => (clock += SIDECAR_WAIT_MS / 4), noDelay);
    await expect(waiting).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops when the player closes or the session changes", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockImplementation(() => { controller.abort(); return Promise.resolve(response(true)); });
    await expect(waitForSidecar("/sidecar.vtt", controller.signal, fetcher, Date.now, noDelay)).resolves.toBe(false);
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
      void waitForSidecar("/sidecar.vtt", new AbortController().signal, fetcher as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(SIDECAR_REQUEST_MS + 1);
      expect(signals[0].aborted).toBe(true);
      expect(any).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("leaves no pending request timer behind once the file answers", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue(response(true));
      await expect(waitForSidecar("/sidecar.vtt", new AbortController().signal, fetcher)).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
