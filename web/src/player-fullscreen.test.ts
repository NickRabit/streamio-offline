import { afterEach, expect, test, vi } from "vitest";
import { enterPlayerFullscreen, exitPlayerFullscreen, playerIsFullscreen, supportsPlayerFullscreen } from "./player-fullscreen";

afterEach(() => vi.unstubAllGlobals());

test("fullscreen requests the overlay and follows the actual browser state", async () => {
  const requestFullscreen = vi.fn().mockResolvedValue(undefined);
  const overlay = { requestFullscreen } as unknown as HTMLElement;
  const state = { fullscreenEnabled: true, fullscreenElement: null as Element | null };
  vi.stubGlobal("document", state);
  expect(supportsPlayerFullscreen(overlay)).toBe(true);
  expect(await enterPlayerFullscreen(overlay)).toBe(true);
  expect(requestFullscreen).toHaveBeenCalledOnce();
  expect(playerIsFullscreen(overlay)).toBe(false);
  state.fullscreenElement = overlay;
  expect(playerIsFullscreen(overlay)).toBe(true);
});

test("unsupported Safari overlay fullscreen does not offer a fake mode", async () => {
  vi.stubGlobal("document", { fullscreenEnabled: false });
  const requestFullscreen = vi.fn();
  const overlay = { requestFullscreen } as unknown as HTMLElement;
  expect(supportsPlayerFullscreen(overlay)).toBe(false);
  expect(await enterPlayerFullscreen(overlay)).toBe(false);
  expect(requestFullscreen).not.toHaveBeenCalled();
});

test("rejected fullscreen reports failure without switching players", async () => {
  vi.stubGlobal("document", { fullscreenEnabled: true });
  const overlay = { requestFullscreen: vi.fn().mockRejectedValue(new Error("Denied")) } as unknown as HTMLElement;
  expect(await enterPlayerFullscreen(overlay)).toBe(false);
});

test("prefixed Safari API enters and exits only the custom overlay", async () => {
  const enter = vi.fn();
  const exit = vi.fn();
  const overlay = { webkitRequestFullscreen: enter } as unknown as HTMLElement;
  const state = { webkitFullscreenElement: null as Element | null, webkitExitFullscreen: exit };
  vi.stubGlobal("document", state);
  expect(supportsPlayerFullscreen(overlay)).toBe(true);
  expect(await enterPlayerFullscreen(overlay)).toBe(true);
  expect(enter).toHaveBeenCalledOnce();
  state.webkitFullscreenElement = overlay;
  expect(playerIsFullscreen(overlay)).toBe(true);
  await exitPlayerFullscreen();
  expect(exit).toHaveBeenCalledOnce();
});
