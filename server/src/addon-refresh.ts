import type { AddonRecord, AddonRole, StremioManifest } from "./types.js";
import { log } from "./logger.js";

export type ManifestLoader = (url: string, role: AddonRole) => Promise<AddonRecord>;

export interface RefreshOutcome {
  key: string;
  name: string;
  previousVersion: string;
  /** Unchanged from the previous version when the fetch failed. */
  version: string;
  changed: boolean;
  manifest?: StremioManifest;
  error?: string;
}

/** The choices the interface offers, in hours; 0 is off. */
export const REFRESH_HOURS = [0, 6, 12, 24, 48, 168] as const;
const DEFAULT_REFRESH_HOURS = 24;

export function normalizeRefreshHours(value: unknown): number {
  const hours = Number(value);
  return (REFRESH_HOURS as readonly number[]).includes(hours) ? hours : DEFAULT_REFRESH_HOURS;
}

/** A hard switch for a deployment that wants no outbound calls of its own, whatever
 *  the interval in Settings says. */
export const autoRefreshEnabled = () => process.env.ADDON_AUTO_REFRESH !== "0";

/** The moment of the last round is stored, so an instance restarted every day still
 *  refreshes on its own schedule rather than on every boot. */
export function refreshDue(lastAt: string | undefined, hours: number, now = Date.now()): boolean {
  if (hours <= 0) return false;
  if (!lastAt) return true;
  const last = Date.parse(lastAt);
  return Number.isNaN(last) || now - last >= hours * 3_600_000;
}

/** Only the manifest is worth comparing; the rest of the record is ours, not the addon's. */
export const manifestChanged = (before: StremioManifest, after: StremioManifest) => JSON.stringify(before) !== JSON.stringify(after);

/** Addons are asked one at a time: a round is rare and a handful of manifests is quick,
 *  while a burst of parallel requests is what rate limits are there to stop. A failure
 *  keeps the manifest we already have -- a provider being down must not narrow the
 *  resources an addon is known to serve. */
export async function refreshManifests(targets: AddonRecord[], load: ManifestLoader): Promise<RefreshOutcome[]> {
  const outcomes: RefreshOutcome[] = [];
  for (const addon of targets) {
    const previousVersion = addon.manifest.version;
    try {
      const loaded = await load(addon.manifestUrl, addon.role);
      const changed = manifestChanged(addon.manifest, loaded.manifest);
      outcomes.push({ key: addon.key, name: loaded.manifest.name, previousVersion, version: loaded.manifest.version, changed, manifest: loaded.manifest });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log("WARN", "Addon manifest refresh failed", { addon: addon.manifest.name, reason });
      outcomes.push({ key: addon.key, name: addon.manifest.name, previousVersion, version: previousVersion, changed: false, error: reason });
    }
  }
  return outcomes;
}
