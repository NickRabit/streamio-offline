import { Airplay } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { t } from "./i18n";
import { supportsAirPlay, type AirPlayVideo } from "./player-airplay";

export function AirPlayButton({ videoRef, visible, onPrepareNative, onCancelNative }: {
  videoRef: RefObject<HTMLVideoElement | null>; visible: boolean;
  onPrepareNative?: () => void; onCancelNative?: () => void;
}) {
  const [supported, setSupported] = useState(false);
  const [available, setAvailable] = useState(false);
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const video: AirPlayVideo | null = videoRef.current;
    if (!video || !supportsAirPlay(video)) return;
    setSupported(true);
    const update = () => {
      setConnected(Boolean(video.webkitCurrentPlaybackTargetIsWireless));
      setFailed(false);
    };
    update();
    video.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", update);
    return () => video.removeEventListener("webkitcurrentplaybacktargetiswirelesschanged", update);
  }, [videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !supported || !visible) return;
    const update = (event: Event) => setAvailable((event as Event & { availability: string }).availability === "available");
    video.addEventListener("webkitplaybacktargetavailabilitychanged", update);
    return () => video.removeEventListener("webkitplaybacktargetavailabilitychanged", update);
  }, [videoRef, supported, visible]);

  if (!supported) return null;
  const label = t(connected ? "player.airplayConnected" : available ? "player.airplay" : "player.airplayUnavailable");
  return <>
    <button className="airplay-toggle" aria-label={label} title={label} aria-pressed={connected} disabled={!available && !connected} onClick={() => {
      try {
        // Safari can only send audio to a HomePod from a native src, not from hls.js.
        onPrepareNative?.();
        (videoRef.current as AirPlayVideo | null)?.webkitShowPlaybackTargetPicker?.();
        setFailed(false);
      } catch {
        onCancelNative?.();
        setFailed(true);
      }
    }}><Airplay /></button>
    {failed && <span className="fullscreen-notice" role="status">{t("player.airplayFailed")}</span>}
  </>;
}
