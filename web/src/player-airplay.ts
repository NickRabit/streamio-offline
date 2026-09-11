export type AirPlayVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

export const supportsAirPlay = (video: AirPlayVideo) => typeof video.webkitShowPlaybackTargetPicker === "function";

export const isAirPlayWireless = (video: AirPlayVideo) => Boolean(video.webkitCurrentPlaybackTargetIsWireless);

/** HomePods take audio from a native `video.src`. Never just because the device
 *  *could* AirPlay — that forced native HLS on iPhone and refused HEVC remuxes. */
export const prefersNativeAirPlay = (video: AirPlayVideo) =>
  isAirPlayWireless(video) && Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
