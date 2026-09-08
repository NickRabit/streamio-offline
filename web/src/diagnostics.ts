/** Reports from the browser to the server. Player errors otherwise end up in a console the user
 * cannot reach on a television or a phone -- which is exactly where playback fails most often. */
type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const recent = new Map<string, number>();
const REPEAT_MS = 5000;

/** Addresses are not sent to the log in full; the server shortens them too, but a token is not
 * worth sending over the network at all. */
export function hostOf(url?: string) {
  if (!url) return undefined;
  try { return new URL(url, location.origin).host; } catch { return undefined; }
}

export function report(level: Level, message: string, context: Record<string, unknown> = {}) {
  const now = Date.now();
  const last = recent.get(message);
  if (last && now - last < REPEAT_MS) return;
  recent.set(message, now);
  if (recent.size > 50) for (const [key, at] of recent) if (now - at > REPEAT_MS) recent.delete(key);
  // Reporting must never bring down the thing it reports on.
  void fetch("/api/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level, message, context: { ...context, page: location.pathname } }),
    keepalive: true,
  }).catch(() => undefined);
}

const EXTENSION_SOURCE = /(chrome|moz|safari-web|safari)-extension:\/\//;
/** Safari extensions inject their bridge into every page and it throws on ours. */
const EXTENSION_MESSAGE = /webkit\.messageHandlers|__firefox__|browser\.runtime/;

/** How to treat an error caught by the global listeners. A foreign script running in our
 * page is not our failure and only buries the real ones, so it never reaches the log. A
 * rejection without a stack cannot be attributed to anyone and stays a warning. */
export function classifyClientError(input: { message: string; filename?: string; stack?: string }): Level | null {
  const { message, filename = "", stack = "" } = input;
  if (EXTENSION_SOURCE.test(filename) || EXTENSION_SOURCE.test(stack)) return null;
  if (EXTENSION_MESSAGE.test(message)) return null;
  // Cross-origin script has nothing but this placeholder: no file, no line, no stack.
  if (message === "Script error." && !filename && !stack) return null;
  return stack ? "ERROR" : "WARN";
}
