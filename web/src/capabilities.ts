import type { Capabilities } from "./types";

/** iPadOS calls itself Macintosh; only the touch screen gives it away. */
export const isAppleMobile = (userAgent: string, maxTouchPoints: number) =>
  /iPhone|iPad|iPod/.test(userAgent)
  || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);

/** The browser knows best what it can play. The server decides what to copy from this. */
export function detectCapabilities(supports: (type: string) => boolean, userAgent: string, maxTouchPoints: number): Capabilities {
  // MediaSource.isTypeSupported answers for the format, not for the decoder behind it.
  // iPhones and iPads report AC-3 and E-AC-3 and then reject the first segment
  // (bufferAppendError at position 0); only Apple TV really passes them through.
  const appleMobile = isAppleMobile(userAgent, maxTouchPoints);
  return {
    h264: supports('video/mp4; codecs="avc1.640029"'),
    hevc: supports('video/mp4; codecs="hvc1.1.6.L93.B0"'),
    // Main 10 is a separate profile, and plenty of downloads are ten bit.
    hevc10: supports('video/mp4; codecs="hvc1.2.4.L153.B0"'),
    vp8: supports('video/webm; codecs="vp8"'),
    vp9: supports('video/mp4; codecs="vp09.00.10.08"'),
    av1: supports('video/mp4; codecs="av01.0.05M.08"'),
    aac: supports('audio/mp4; codecs="mp4a.40.2"'),
    mp3: supports('audio/mp4; codecs="mp4a.40.34"'),
    opus: supports('audio/mp4; codecs="opus"'),
    vorbis: supports('audio/webm; codecs="vorbis"'),
    ac3: !appleMobile && supports('audio/mp4; codecs="ac-3"'),
    eac3: !appleMobile && supports('audio/mp4; codecs="ec-3"'),
    flac: supports('audio/mp4; codecs="flac"'),
  };
}
