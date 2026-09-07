const attributes: Record<string, Set<string>> = Object.fromEntries(Object.entries({
  "EXT-X-STREAM-INF": ["BANDWIDTH", "AVERAGE-BANDWIDTH", "CODECS", "RESOLUTION", "FRAME-RATE", "AUDIO", "VIDEO", "SUBTITLES", "CLOSED-CAPTIONS"],
  "EXT-X-I-FRAME-STREAM-INF": ["BANDWIDTH", "AVERAGE-BANDWIDTH", "CODECS", "RESOLUTION", "VIDEO", "URI"],
  "EXT-X-MEDIA": ["TYPE", "URI", "GROUP-ID", "LANGUAGE", "ASSOC-LANGUAGE", "NAME", "DEFAULT", "AUTOSELECT", "FORCED", "INSTREAM-ID", "CHARACTERISTICS", "CHANNELS"],
  "EXT-X-KEY": ["METHOD", "URI", "IV", "KEYFORMAT", "KEYFORMATVERSIONS"],
  "EXT-X-SESSION-KEY": ["METHOD", "URI", "IV", "KEYFORMAT", "KEYFORMATVERSIONS"],
  "EXT-X-MAP": ["URI", "BYTERANGE"],
  "EXT-X-PART": ["URI", "DURATION", "INDEPENDENT", "BYTERANGE", "GAP"],
  "EXT-X-PRELOAD-HINT": ["TYPE", "URI", "BYTERANGE-START", "BYTERANGE-LENGTH"],
  "EXT-X-RENDITION-REPORT": ["URI", "LAST-MSN", "LAST-PART"],
  "EXT-X-SERVER-CONTROL": ["CAN-SKIP-UNTIL", "CAN-SKIP-DATERANGES", "HOLD-BACK", "PART-HOLD-BACK", "CAN-BLOCK-RELOAD"],
  "EXT-X-PART-INF": ["PART-TARGET"],
  "EXT-X-START": ["TIME-OFFSET", "PRECISE"],
}).map(([name, values]) => [name, new Set(values)]));
const numeric = new Set(["EXT-X-VERSION", "EXT-X-TARGETDURATION", "EXT-X-MEDIA-SEQUENCE", "EXT-X-DISCONTINUITY-SEQUENCE"]);
const flags = new Set(["EXTM3U", "EXT-X-ENDLIST", "EXT-X-DISCONTINUITY", "EXT-X-GAP", "EXT-X-INDEPENDENT-SEGMENTS", "EXT-X-I-FRAMES-ONLY"]);

export function rewritePlaylist(text: string, resource: (uri: string) => string, safeText: (text: string) => string = (text) => text): string {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024 || !text.trimStart().startsWith("#EXTM3U")) throw new Error("Unsupported media playlist.");
  const fail = (): never => { throw new Error("Unsupported media playlist."); };
  const output = text.replace(/^\ufeff/, "").split(/\r?\n/).flatMap((raw): string[] => {
    const line = raw.trim();
    if (!line) return [];
    if (line.includes("{$") || /[\u0000-\u001f]/.test(line)) return fail();
    if (!line.startsWith("#")) return [resource(line)];
    const colon = line.indexOf(":");
    const tag = line.slice(1, colon < 0 ? undefined : colon);
    const value = colon < 0 ? "" : line.slice(colon + 1);
    if (flags.has(tag)) return value ? fail() : [`#${tag}`];
    if (numeric.has(tag)) return /^\d+$/.test(value) ? [line] : fail();
    if (tag === "EXTINF") {
      const duration = value.split(",")[0];
      return /^\d+(?:\.\d+)?$/.test(duration) ? [`#EXTINF:${duration},`] : fail();
    }
    if (tag === "EXT-X-BYTERANGE") return /^\d+(?:@\d+)?$/.test(value) ? [line] : fail();
    if (tag === "EXT-X-PLAYLIST-TYPE") return /^(VOD|EVENT)$/.test(value) ? [line] : fail();
    if (tag === "EXT-X-PROGRAM-DATE-TIME") return /^[\dT:Z.+-]+$/.test(value) ? [line] : fail();
    if (tag === "EXT-X-SESSION-DATA" || tag === "EXT-X-DATERANGE") return [];
    const allowed = attributes[tag];
    if (!allowed) return tag.startsWith("EXT") ? fail() : [];
    const parts: string[] = [];
    const seen = new Set<string>();
    let remaining = value;
    while (remaining) {
      const match = /^([A-Z0-9-]+)=("[^"\r\n]*"|[^,]+)(?:,|$)/.exec(remaining);
      if (!match || !allowed.has(match[1]) || seen.has(match[1])) return fail();
      const [, name, encoded] = match;
      seen.add(name);
      const quoted = encoded.startsWith('"');
      const decoded = quoted ? encoded.slice(1, -1) : encoded;
      if (name === "URI") {
        if (!quoted || !decoded) return fail();
        parts.push(`URI="${resource(decoded)}"`);
      } else {
        if (!/^[A-Za-z0-9 .,/_@+:-]+$/.test(decoded) || /(?:https?:|%|=)/i.test(decoded)) return fail();
        if (name === "KEYFORMAT" && decoded !== "identity") return fail();
        const sanitized = safeText(decoded);
        parts.push(`${name}=${quoted ? JSON.stringify(sanitized) : sanitized}`);
      }
      remaining = remaining.slice(match[0].length);
    }
    if (!parts.length) return fail();
    return [`#${tag}:${parts.join(",")}`];
  });
  return `${output.join("\n")}\n`;
}


export async function readMediaText(response: Response, maxBytes = 2 * 1024 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Media text exceeds the supported size.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
