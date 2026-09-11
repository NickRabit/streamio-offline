import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AirPlayButton } from "./AirPlayButton";
import { prefersNativeAirPlay, type AirPlayVideo } from "./player-airplay";

let host: HTMLDivElement;
let root: Root;
let video: AirPlayVideo;
const render = (visible = true) => {
  const videoRef = createRef<HTMLVideoElement>();
  videoRef.current = video;
  act(() => root.render(<AirPlayButton videoRef={videoRef} visible={visible} />));
};
const availability = (value: string) => act(() => video.dispatchEvent(Object.assign(new Event("webkitplaybacktargetavailabilitychanged"), { availability: value })));
const wireless = (value: boolean) => {
  video.webkitCurrentPlaybackTargetIsWireless = value;
  act(() => video.dispatchEvent(new Event("webkitcurrentplaybacktargetiswirelesschanged")));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  video = document.createElement("video");
  video.webkitShowPlaybackTargetPicker = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test("unsupported browsers do not show AirPlay", () => {
  delete video.webkitShowPlaybackTargetPicker;
  render();
  expect(host.querySelector("button")).toBeNull();
});

test("device discovery enables a user-initiated picker and disconnection preserves the player", () => {
  const play = vi.spyOn(video, "play");
  const pause = vi.spyOn(video, "pause");
  render();
  const button = host.querySelector("button")!;
  expect(button.disabled).toBe(true);
  availability("available");
  expect(button.disabled).toBe(false);
  expect(video.webkitShowPlaybackTargetPicker).not.toHaveBeenCalled();
  act(() => button.click());
  expect(video.webkitShowPlaybackTargetPicker).toHaveBeenCalledOnce();
  wireless(true);
  availability("not-available");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.disabled).toBe(false);
  wireless(false);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.disabled).toBe(true);
  expect(play).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
  expect(video.controls).toBe(false);
});

test("picker rejection is recoverable without changing media", () => {
  video.webkitShowPlaybackTargetPicker = vi.fn().mockImplementationOnce(() => { throw new Error("Unavailable"); });
  render();
  availability("available");
  act(() => host.querySelector("button")!.click());
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  act(() => host.querySelector("button")!.click());
  expect(host.querySelector('[role="status"]')).toBeNull();
});

test("listeners are removed on unmount", () => {
  const remove = vi.spyOn(video, "removeEventListener");
  render();
  act(() => root.render(null));
  expect(remove).toHaveBeenCalledWith("webkitplaybacktargetavailabilitychanged", expect.any(Function));
  expect(remove).toHaveBeenCalledWith("webkitcurrentplaybacktargetiswirelesschanged", expect.any(Function));
});

test("native HLS is preferred only when HLS and AirPlay are both supported", () => {
  vi.spyOn(video, "canPlayType").mockReturnValue("probably");
  expect(prefersNativeAirPlay(video)).toBe(true);
  delete video.webkitShowPlaybackTargetPicker;
  expect(prefersNativeAirPlay(video)).toBe(false);
  video.webkitShowPlaybackTargetPicker = vi.fn();
  vi.spyOn(video, "canPlayType").mockReturnValue("");
  expect(prefersNativeAirPlay(video)).toBe(false);
});
