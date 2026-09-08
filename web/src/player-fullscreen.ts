type FullscreenDocument = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> };

export function supportsPlayerFullscreen(overlay: HTMLElement | null) {
  return Boolean(overlay && ((typeof overlay.requestFullscreen === "function" && document.fullscreenEnabled) || (overlay as FullscreenElement).webkitRequestFullscreen));
}

export function playerIsFullscreen(overlay: HTMLElement | null) {
  const active = document.fullscreenElement ?? (document as FullscreenDocument).webkitFullscreenElement;
  return Boolean(active && active === overlay);
}

export async function enterPlayerFullscreen(overlay: HTMLElement | null) {
  if (!overlay) return false;
  if (playerIsFullscreen(overlay)) return true;
  try {
    if (typeof overlay.requestFullscreen === "function" && document.fullscreenEnabled) {
      await overlay.requestFullscreen();
      return true;
    }
    const prefixed = overlay as FullscreenElement;
    if (prefixed.webkitRequestFullscreen) { await prefixed.webkitRequestFullscreen(); return true; }
  } catch { /* Fullscreen requires browser permission and a user gesture. */ }
  return false;
}

export async function exitPlayerFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else (document as FullscreenDocument).webkitExitFullscreen?.();
  } catch { /* The browser may already have left fullscreen. */ }
}
