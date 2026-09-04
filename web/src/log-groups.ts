/** Řádek logu ze serveru: čas, úroveň, zpráva a volitelný kontext v JSON. */
export interface LogLine { at: string; level: string; message: string; context?: string; raw: string }
/** Stejné chyby se seskupují dohromady, ať je vidět "tohle se stalo 40×", ne 40 řádků. */
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

// Identifikátory relací, cesty a čísla se v každém výskytu liší, ale jde pořád o tutéž chybu.
const fingerprint = (message: string) => message
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
  .replace(/\b\d+([.,]\d+)?\b/g, "<n>")
  .trim();

const RANK: Record<string, number> = { ERROR: 3, WARN: 2, INFO: 1, DEBUG: 0 };

/** Seskupí stejné záznamy a seřadí je od nejzávažnějších a nejčerstvějších. */
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
      // Stačí pár posledních výskytů; ty starší už nic nového neřeknou.
      group.samples = [line, ...group.samples].slice(0, 3);
    }
  }
  return [...groups.values()].sort((a, b) => (RANK[b.level] ?? 0) - (RANK[a.level] ?? 0) || b.last.localeCompare(a.last));
}
