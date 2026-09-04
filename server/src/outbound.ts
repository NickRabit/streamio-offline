import { log } from "./logger.js";
import { safeFetch } from "./security.js";

/**
 * Guards outgoing calls to third-party addons. Two independent mechanisms per host:
 * a concurrency/spacing limit so we never pile requests onto one provider, and a
 * circuit breaker so a dead addon fails instantly instead of costing a full timeout
 * on every search. Media transfers deliberately do not go through here -- they are
 * long-lived by design and would both hold a slot and trip the breaker when the
 * user simply stops playback.
 */

export interface GuardConfig {
  enabled: boolean;
  maxConcurrent: number;
  minIntervalMs: number;
  maxQueue: number;
  failureThreshold: number;
  cooldownMs: number;
  maxCooldownMs: number;
}

const number = (value: string | undefined, fallback: number, min = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  return {
    enabled: env.ADDON_GUARD !== "0",
    maxConcurrent: Math.max(1, number(env.ADDON_MAX_CONCURRENT, 4, 1)),
    minIntervalMs: number(env.ADDON_MIN_INTERVAL_MS, 100),
    maxQueue: Math.max(1, number(env.ADDON_MAX_QUEUE, 32, 1)),
    failureThreshold: Math.max(1, number(env.ADDON_BREAKER_FAILURES, 5, 1)),
    cooldownMs: Math.max(1000, number(env.ADDON_BREAKER_COOLDOWN_MS, 30_000, 1000)),
    maxCooldownMs: Math.max(1000, number(env.ADDON_BREAKER_MAX_COOLDOWN_MS, 300_000, 1000)),
  };
}

export type BreakerState = "closed" | "open" | "half-open";

interface HostState {
  active: number;
  queue: Array<() => void>;
  lastStartedAt: number;
  touchedAt: number;
  state: BreakerState;
  failures: number;
  openUntil: number;
  cooldownMs: number;
  trialInFlight: boolean;
  rejected: number;
  opened: number;
}

export class GuardRejection extends Error {
  constructor(message: string, readonly host: string, readonly retryAfterMs: number) {
    super(message);
    this.name = "GuardRejection";
  }
}

const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));

/** Providers ask for a pause in seconds or as an HTTP date; both forms appear in the wild. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const asSeconds = Number(header.trim());
  if (Number.isFinite(asSeconds)) return asSeconds > 0 ? asSeconds * 1000 : undefined;
  const asDate = Date.parse(header);
  return Number.isFinite(asDate) && asDate > now ? asDate - now : undefined;
}

const IDLE_MS = 60 * 60_000;

export class OutboundGuard {
  private hosts = new Map<string, HostState>();

  constructor(
    private config: GuardConfig = configFromEnv(),
    private now: () => number = Date.now,
    private delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  ) {}

  private stateOf(host: string): HostState {
    let entry = this.hosts.get(host);
    if (!entry) {
      entry = {
        active: 0, queue: [], lastStartedAt: 0, touchedAt: this.now(),
        state: "closed", failures: 0, openUntil: 0, cooldownMs: this.config.cooldownMs,
        trialInFlight: false, rejected: 0, opened: 0,
      };
      this.hosts.set(host, entry);
    }
    entry.touchedAt = this.now();
    return entry;
  }

  /** Hosts nobody has talked to for an hour only keep the map growing. */
  private prune() {
    if (this.hosts.size < 64) return;
    const cutoff = this.now() - IDLE_MS;
    for (const [host, entry] of this.hosts) {
      if (entry.touchedAt < cutoff && !entry.active && !entry.queue.length && entry.state === "closed") this.hosts.delete(host);
    }
  }

  private admit(host: string, entry: HostState) {
    if (entry.state === "open") {
      if (this.now() < entry.openUntil) {
        entry.rejected += 1;
        throw new GuardRejection(
          `${host} opakovaně neodpovídá, další pokus za ${seconds(entry.openUntil - this.now())} s.`,
          host, entry.openUntil - this.now(),
        );
      }
      entry.state = "half-open";
      entry.trialInFlight = false;
      log("INFO", "Circuit breaker is testing the host again", { host });
    }
    // Half-open lets exactly one request through; everything else keeps failing fast
    // so a burst of searches cannot hammer a host that has not proven itself yet.
    if (entry.state === "half-open") {
      if (entry.trialInFlight) {
        entry.rejected += 1;
        throw new GuardRejection(`${host} se právě zkouší po výpadku, zkuste to za chvíli.`, host, entry.cooldownMs);
      }
      entry.trialInFlight = true;
    }
  }

  private async acquire(entry: HostState) {
    if (entry.active >= this.config.maxConcurrent) {
      if (entry.queue.length >= this.config.maxQueue) throw new Error("Fronta požadavků na doplněk je plná.");
      await new Promise<void>((resolve) => entry.queue.push(resolve));
    }
    entry.active += 1;
    const wait = entry.lastStartedAt + this.config.minIntervalMs - this.now();
    if (wait > 0) await this.delay(wait);
    entry.lastStartedAt = this.now();
  }

  private release(entry: HostState) {
    entry.active -= 1;
    entry.queue.shift()?.();
  }

  private succeed(host: string, entry: HostState) {
    entry.trialInFlight = false;
    if (entry.state !== "closed") log("INFO", "The host answers again, circuit breaker closed", { host });
    entry.state = "closed";
    entry.failures = 0;
    entry.cooldownMs = this.config.cooldownMs;
  }

  private fail(host: string, entry: HostState, reason: string, pauseMs?: number) {
    entry.failures += 1;
    const trial = entry.state === "half-open";
    entry.trialInFlight = false;
    if (!trial && entry.failures < this.config.failureThreshold && pauseMs === undefined) return;
    // A failed trial means the previous cooldown was too short; each further outage waits longer.
    if (trial) entry.cooldownMs = Math.min(this.config.maxCooldownMs, entry.cooldownMs * 2);
    const pause = Math.min(this.config.maxCooldownMs, Math.max(pauseMs ?? 0, entry.cooldownMs));
    entry.state = "open";
    entry.openUntil = this.now() + pause;
    entry.opened += 1;
    log("WARN", "Circuit breaker opened for the host", { host, failures: entry.failures, pauseSeconds: seconds(pause), reason });
  }

  async run(host: string, task: () => Promise<Response>): Promise<Response> {
    if (!this.config.enabled) return task();
    this.prune();
    const entry = this.stateOf(host);
    this.admit(host, entry);
    try {
      await this.acquire(entry);
    } catch (error) {
      entry.trialInFlight = false;
      throw error;
    }
    try {
      const response = await task();
      // Only the provider's own trouble counts. A 404 on metadata is a plain answer,
      // not an outage, and must never take the addon out of service.
      if (response.status === 429 || response.status >= 500) {
        this.fail(host, entry, `HTTP ${response.status}`, retryAfterMs(response.headers.get("retry-after"), this.now()));
      } else {
        this.succeed(host, entry);
      }
      return response;
    } catch (error) {
      this.fail(host, entry, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.release(entry);
    }
  }

  diagnostics() {
    const now = this.now();
    return [...this.hosts.entries()]
      .filter(([, entry]) => entry.state !== "closed" || entry.failures || entry.rejected || entry.active)
      .map(([host, entry]) => ({
        host,
        state: entry.state,
        active: entry.active,
        queued: entry.queue.length,
        failures: entry.failures,
        rejected: entry.rejected,
        opened: entry.opened,
        opensInSeconds: entry.state === "open" ? seconds(entry.openUntil - now) : undefined,
      }));
  }
}

export const outbound = new OutboundGuard();

const hostOf = (raw: string): string | undefined => {
  try { return new URL(raw.replace(/^stremio:\/\//i, "https://")).hostname.toLowerCase(); }
  catch { return undefined; }
};

/**
 * safeFetch plus the guard above. Only for short third-party calls -- addon JSON,
 * subtitles, artwork. Media transfers keep using safeFetch directly.
 */
export async function guardedFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  const host = hostOf(raw);
  if (!host) return safeFetch(raw, init);
  return outbound.run(host, () => safeFetch(raw, init));
}
