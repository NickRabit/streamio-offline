/** Live transfer speed per key. The statistics log tells how much has flowed since the
 * beginning; this says how fast it is flowing right now, which is what a running stream
 * is watched by. Nothing is persisted -- a restart has no streams running anyway. */

/** The speed is averaged over this span, so a paused buffer does not read as a stall. */
const WINDOW_MS = 20_000;

interface Sample { at: number; bytes: number }

export interface Rate {
  /** Everything the key has transferred since it was first seen. */
  bytes: number;
  /** Bytes per second over the averaging window; zero once nothing arrives. */
  rate: number;
}

export class Throughput {
  private totals = new Map<string, number>();
  private samples = new Map<string, Sample[]>();

  add(key: string, bytes: number, now = Date.now()) {
    if (bytes <= 0) return;
    const total = (this.totals.get(key) ?? 0) + bytes;
    this.totals.set(key, total);
    const samples = this.samples.get(key) ?? [];
    samples.push({ at: now, bytes: total });
    this.samples.set(key, trim(samples, now));
  }

  read(key: string, now = Date.now()): Rate {
    const bytes = this.totals.get(key) ?? 0;
    const samples = trim(this.samples.get(key) ?? [], now);
    this.samples.set(key, samples);
    const first = samples[0], last = samples[samples.length - 1];
    if (!first || !last || last.at <= first.at) return { bytes, rate: 0 };
    return { bytes, rate: Math.round(((last.bytes - first.bytes) * 1000) / (last.at - first.at)) };
  }

  forget(key: string) {
    this.totals.delete(key);
    this.samples.delete(key);
  }
}

/** Samples older than the window go, except the last one before it: without that anchor
 * the average would start at the first sample inside the window and read too low. */
function trim(samples: Sample[], now: number): Sample[] {
  const from = now - WINDOW_MS;
  let anchor = 0;
  for (let index = 0; index < samples.length; index += 1) if (samples[index].at < from) anchor = index;
  return samples.slice(anchor);
}
