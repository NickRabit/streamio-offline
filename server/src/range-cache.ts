/** Every FFmpeg that opens a film reads the same two places first: the header at the start and
 *  the index at the end. With a conversion and a subtitle reader, and both of them starting over
 *  at every seek, that is the same few megabytes fetched again and again -- and these hosts count
 *  connections, not bytes. What has been read once is kept, so only the picture itself is fetched. */
export interface CachedRange { status: number; headers: Record<string, string>; bytes: Buffer; complete: boolean }

export class RangeCache {
  private entries = new Map<string, { value: CachedRange; at: number }>();
  private bytes = 0;

  constructor(
    private readonly perRange = 4 * 1024 * 1024,
    private readonly total = 64 * 1024 * 1024,
    private readonly ttlMs = 10 * 60_000,
    private readonly now = () => Date.now(),
  ) {}

  /** The whole range, not just where it starts: an answer to "bytes=0-" is not an answer to
   *  "bytes=0-31", and handing one over for the other would truncate or overrun the reply. */
  private key(resource: string, range: string) { return `${resource}:${range}`; }

  get(resource: string, range: string): CachedRange | undefined {
    const key = this.key(resource, range);
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) { this.drop(key); return undefined; }
    // Keeping it fresh: what a demuxer reads at the start of one conversion it reads at the next.
    this.entries.delete(key);
    this.entries.set(key, { value: hit.value, at: this.now() });
    return hit.value;
  }

  put(resource: string, range: string, value: CachedRange) {
    if (!value.bytes.length || value.bytes.length > this.perRange) return;
    const key = this.key(resource, range);
    this.drop(key);
    this.entries.set(key, { value, at: this.now() });
    this.bytes += value.bytes.length;
    while (this.bytes > this.total) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
  }

  /** A source that is gone takes what was read from it: the claim it was read under is over. */
  forget(resource: string) {
    for (const key of [...this.entries.keys()]) if (key.startsWith(`${resource}:`)) this.drop(key);
  }

  private drop(key: string) {
    const held = this.entries.get(key);
    if (!held) return;
    this.bytes -= held.value.bytes.length;
    this.entries.delete(key);
  }

  get size() { return this.bytes; }
  /** How much of a range is worth keeping; a longer read is the film, not an index. */
  get limit() { return this.perRange; }
}
