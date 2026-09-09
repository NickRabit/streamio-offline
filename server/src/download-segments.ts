/** One part of a file, downloaded over its own connection. `received` counts from `start`,
 *  so a plan restored from the state file resumes exactly where each connection stopped. */
export interface Segment { start: number; end: number; received: number }

/** Splitting pays off only while every part is still worth a connection of its own.
 *  A short file is faster over one stream than over several handshakes. */
export const MIN_SEGMENT_BYTES = 16 * 1024 ** 2;

export const MAX_SEGMENTS = 8;

export function segmentCount(value: unknown): number {
  const wanted = Math.trunc(Number(value));
  if (!Number.isFinite(wanted) || wanted < 1) return 1;
  return Math.min(MAX_SEGMENTS, wanted);
}

export function planSegments(total: number, wanted: number, minBytes = MIN_SEGMENT_BYTES): Segment[] {
  if (!Number.isFinite(total) || total <= 0) return [];
  const parts = Math.max(1, Math.min(segmentCount(wanted), Math.floor(total / minBytes)));
  const size = Math.floor(total / parts);
  return Array.from({ length: parts }, (_unused, index) => ({
    start: index * size,
    end: index === parts - 1 ? total - 1 : (index + 1) * size - 1,
    received: 0,
  }));
}

export function segmentedBytes(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + segment.received, 0);
}

export const segmentSize = (segment: Segment) => segment.end - segment.start + 1;

/** A plan from the state file is trusted only when it still describes the same file, byte for
 *  byte: parts that follow one another from zero to the last byte, none of them overfull. */
export function usableSegments(value: unknown, total: number | undefined): Segment[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_SEGMENTS || !total) return undefined;
  const segments: Segment[] = [];
  let next = 0;
  for (const raw of value) {
    const item = raw as Partial<Segment> | null;
    const start = Number(item?.start); const end = Number(item?.end); const received = Number(item?.received);
    if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(received)) return undefined;
    if (start !== next || end < start) return undefined;
    if (received < 0 || received > end - start + 1) return undefined;
    segments.push({ start, end, received });
    next = end + 1;
  }
  return next === total ? segments : undefined;
}
