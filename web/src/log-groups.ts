/** One log line from the server: time, level, message and optional context as JSON. */
export interface LogLine { at: string; level: string; message: string; context?: string; raw: string }
/** Identical errors are grouped together, so it reads "this happened 40 times" rather than 40 lines. */
export interface LogGroup { key: string; level: string; message: string; count: number; first: string; last: string; samples: LogLine[] }

const LINE = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(DEBUG|INFO|WARN|ERROR)\s+([\s\S]*)$/;

export function parseLog(text: string): LogLine[] {
  return text.split("\n").filter(Boolean).map((raw) => {
    const match = LINE.exec(raw);
    if (!match) return { at: "", level: "", message: raw, raw };
    const rest = match[3];
    const start = rest.indexOf(" {");
    return {
      at: match[1], level: match[2], raw,
      message: start < 0 ? rest : rest.slice(0, start),
      context: start < 0 ? undefined : rest.slice(start + 1),
    };
  });
}

// Session ids, paths and numbers differ in every occurrence, but the error is still the same one.
const fingerprint = (message: string) => message
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
  .replace(/\b\d+([.,]\d+)?\b/g, "<n>")
  .trim();

const RANK: Record<string, number> = { ERROR: 3, WARN: 2, INFO: 1, DEBUG: 0 };

/** Groups identical entries and orders them from the most severe and most recent. */
export function groupLog(lines: LogLine[], levels = ["WARN", "ERROR"]): LogGroup[] {
  const groups = new Map<string, LogGroup>();
  for (const line of lines) {
    if (levels.length && !levels.includes(line.level)) continue;
    const key = `${line.level}|${fingerprint(line.message)}`;
    const group = groups.get(key);
    if (!group) groups.set(key, { key, level: line.level, message: line.message, count: 1, first: line.at, last: line.at, samples: [line] });
    else {
      group.count += 1;
      group.last = line.at;
      // A few of the latest occurrences are enough; the older ones say nothing new.
      group.samples = [line, ...group.samples].slice(0, 3);
    }
  }
  return [...groups.values()].sort((a, b) => (RANK[b.level] ?? 0) - (RANK[a.level] ?? 0) || b.last.localeCompare(a.last));
}
