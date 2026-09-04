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
