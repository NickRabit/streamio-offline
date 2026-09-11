export type AirPlayVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

export const supportsAirPlay = (video: AirPlayVideo) => typeof video.webkitShowPlaybackTargetPicker === "function";

export const prefersNativeAirPlay = (video: AirPlayVideo) => supportsAirPlay(video) && Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
