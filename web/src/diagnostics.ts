/** Hlášení z prohlížeče na server. Chyby přehrávače jinak skončí v konzoli, ke které se
 * uživatel na televizi ani na mobilu nedostane -- a právě tam přehrávání selhává nejčastěji. */
type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const recent = new Map<string, number>();
const REPEAT_MS = 5000;

/** Adresy se do logu neposílají celé; server je sice také zkracuje, ale token nemá cenu
 * posílat po síti vůbec. */
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
  // Hlášení nesmí nikdy shodit to, co hlásí.
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
