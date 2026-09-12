/** Live transfer speed per key. The statistics log tells how much has flowed since the
 * beginning; this says how fast it is flowing right now, which is what a running stream
 * is watched by. Nothing is persisted -- a restart has no streams running anyway. */

/** The speed is averaged over this span, so a paused buffer does not read as a stall. */
const WINDOW_MS = 20_000;

interface Sample { at: number; bytes: number }
interface Samples { values: Sample[]; head: number }

export interface Rate {
  /** Everything the key has transferred since it was first seen. */
  bytes: number;
  /** Bytes per second over the averaging window; zero once nothing arrives. */
  rate: number;
}

export class Throughput {
  private totals = new Map<string, number>();
  private samples = new Map<string, Samples>();

  add(key: string, bytes: number, now = Date.now()) {
    if (bytes <= 0) return;
    const total = (this.totals.get(key) ?? 0) + bytes;
    this.totals.set(key, total);
    const samples = this.samples.get(key) ?? { values: [], head: 0 };
    // Writes landing in the same millisecond are one sample. The speed is read from
    // timestamps, so a second sample stamped alike says nothing the first cannot -- and a
    // fast transfer writes several times a millisecond, all of them kept for twenty seconds.
    const last = samples.values[samples.values.length - 1];
    if (last && last.at === now) last.bytes = total;
    else samples.values.push({ at: now, bytes: total });
    trim(samples, now);
    this.samples.set(key, samples);
  }

  read(key: string, now = Date.now()): Rate {
    const bytes = this.totals.get(key) ?? 0;
    const samples = this.samples.get(key);
    if (!samples) return { bytes, rate: 0 };
    trim(samples, now);
    const first = samples.values[samples.head], last = samples.values[samples.values.length - 1];
    if (!first || !last || last.at <= first.at) return { bytes, rate: 0 };
    return { bytes, rate: Math.round(((last.bytes - first.bytes) * 1000) / (last.at - first.at)) };
  }

  forget(key: string) {
    this.totals.delete(key);
    this.samples.delete(key);
  }
}

/** Samples older than the window go, except the last one before it: without that anchor
 * the average would start at the first sample inside the window and read too low.
 *
 * They go by moving the read position, not by copying what is left. Every write used to
 * walk the whole window and then copy it, which made this the most expensive thing the
 * server did while a film was transferring -- and the cost grew with the square of the
 * speed, because a faster stream both writes more often and keeps more samples in the
 * twenty seconds. At fifty megabytes a second that was a third of a processor spent on
 * statistics. The array is copied only once the dead part is both large and most of it. */
function trim(samples: Samples, now: number) {
  const from = now - WINDOW_MS;
  const values = samples.values;
  while (samples.head + 1 < values.length && values[samples.head + 1].at < from) samples.head++;
  if (samples.head >= 1024 && samples.head * 2 >= values.length) {
    samples.values = values.slice(samples.head);
    samples.head = 0;
  }
}
