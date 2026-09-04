import { describe, expect, it } from "vitest";
import { HLS_PLAYER_CONFIG, ignoreHlsErrorDuringRestart, planSeek, waitForSeekable } from "./player-hls";

describe("HLS_PLAYER_CONFIG", () => {
  it("keeps the forward buffer short enough that an 8x remux burst should not fill MSE", () => {
    expect(HLS_PLAYER_CONFIG.maxBufferLength).toBeLessThanOrEqual(30);
    expect(HLS_PLAYER_CONFIG.maxMaxBufferLength).toBeLessThanOrEqual(60);
    expect(HLS_PLAYER_CONFIG.maxBufferSize).toBeLessThanOrEqual(60 * 1000 * 1000);
  });

  it("still treats EVENT playlists as VOD-like, not live TV", () => {
    expect(HLS_PLAYER_CONFIG.liveDurationInfinity).toBe(true);
    expect(HLS_PLAYER_CONFIG.liveSyncDurationCount).toBe(1);
    expect(HLS_PLAYER_CONFIG.testBandwidth).toBe(false);
  });
});

describe("ignoreHlsErrorDuringRestart", () => {
  it("swallows errors only while a seek or track switch is replacing the playlist", () => {
    expect(ignoreHlsErrorDuringRestart(true)).toBe(true);
    expect(ignoreHlsErrorDuringRestart(false)).toBe(false);
  });
});

describe("planSeek", () => {
  it("uses the current playlist for skips already converted", () => {
    expect(planSeek(5, 12)).toBe("native");
    expect(planSeek(11.4, 12)).toBe("native");
  });

  it("waits for FFmpeg on a short skip just ahead of the playlist", () => {
    expect(planSeek(10, 2)).toBe("wait");
    expect(planSeek(21.5, 2)).toBe("wait");
  });

  it("restarts conversion for a jump backward or far ahead", () => {
    expect(planSeek(-1, 12)).toBe("restart");
    expect(planSeek(40, 2)).toBe("restart");
  });
});

describe("waitForSeekable", () => {
  it("resolves once the playlist covers the target", async () => {
    let end = 2;
    const ok = waitForSeekable(() => end, 10, 1000, () => false, Date.now, async () => { end = 12; });
    await expect(ok).resolves.toBe(true);
  });

  it("stops when a newer seek supersedes the wait", async () => {
    const ok = await waitForSeekable(() => 2, 10, 1000, () => true, Date.now, async () => undefined);
    expect(ok).toBe(false);
  });
});
