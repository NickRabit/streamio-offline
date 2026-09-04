import { describe, expect, it } from "vitest";
import { HLS_PLAYER_CONFIG, ignoreHlsErrorDuringRestart } from "./player-hls";

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
