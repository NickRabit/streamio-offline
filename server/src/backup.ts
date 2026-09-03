import type { AddonDownloadSettings, AddonRecord, AddonRole } from "./types.js";
import { normalizeDownloadSettings } from "./naming.js";
import { defaultSettings, type Settings } from "./store.js";
import { normalizeLanguage } from "./language.js";

export const BACKUP_FORMAT = "stremio-offline-settings";
export const BACKUP_VERSION = 1;
const ROLES = new Set<AddonRole>(["catalog", "source", "both"]);
const STREAM_SORTS = new Set(["recommended", "size-desc", "size-asc", "addon"]);
const TILE_SIZES = new Set(["compact", "small", "medium", "large"]);

export interface BackupAddon {
  manifestUrl: string;
  role: AddonRole;
  enabled: boolean;
  addedAt: string;
  downloadSettings: AddonDownloadSettings;
}

export interface SettingsBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  settings: Settings;
  addons: BackupAddon[];
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Soubor zálohy nemá platný formát.");
  return value as Record<string, unknown>;
};

export function createSettingsBackup(settings: Settings, addons: AddonRecord[]): SettingsBackup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: structuredClone(settings),
    addons: addons.map(({ manifestUrl, role, enabled, addedAt, downloadSettings }) => ({
      manifestUrl, role, enabled, addedAt, downloadSettings: structuredClone(downloadSettings),
    })),
  };
}

function parseSettings(value: unknown): Settings {
  const source = object(value);
  const fallback = defaultSettings();
  const number = (name: keyof Settings, maximum: number) => Math.max(1, Math.min(maximum, Number(source[name]) || fallback[name] as number));
  const boolean = (name: keyof Settings) => typeof source[name] === "boolean" ? source[name] as boolean : fallback[name] as boolean;
  const audioLanguage = normalizeLanguage(String(source.audioLanguage ?? "")) ?? fallback.audioLanguage;
  const subtitleLanguage = normalizeLanguage(String(source.subtitleLanguage ?? "")) ?? fallback.subtitleLanguage;
  const streamSort = String(source.streamSort ?? "");
  const catalogTileSize = String(source.catalogTileSize ?? "");
  const libraryTileSize = String(source.libraryTileSize ?? "");
  return {
    concurrentDownloads: number("concurrentDownloads", 8),
    parallelPerProvider: number("parallelPerProvider", 8),
    audioLanguage, subtitleLanguage,
    mergeByName: boolean("mergeByName"),
    streamSort: STREAM_SORTS.has(streamSort) ? streamSort : fallback.streamSort,
    artworkLocation: source.artworkLocation === "media" ? "media" : "data",
    trackProgress: boolean("trackProgress"),
    showResumeRow: boolean("showResumeRow"),
    catalogTileSize: TILE_SIZES.has(catalogTileSize) ? catalogTileSize as Settings["catalogTileSize"] : fallback.catalogTileSize,
    libraryTileSize: TILE_SIZES.has(libraryTileSize) ? libraryTileSize as Settings["libraryTileSize"] : fallback.libraryTileSize,
  };
}

export function parseSettingsBackup(value: unknown): Omit<SettingsBackup, "exportedAt"> & { exportedAt?: string } {
  const root = object(value);
  if (root.format !== BACKUP_FORMAT || root.version !== BACKUP_VERSION) throw new Error("Soubor není podporovaná záloha nastavení Stremio Offline.");
  if (!Array.isArray(root.addons) || root.addons.length > 100) throw new Error("Seznam doplňků v záloze není platný.");
  const addons = root.addons.map((raw, index): BackupAddon => {
    const item = object(raw);
    const manifestUrl = typeof item.manifestUrl === "string" ? item.manifestUrl.trim() : "";
    if (!manifestUrl) throw new Error(`Doplněk č. ${index + 1} nemá adresu manifestu.`);
    const role = item.role as AddonRole;
    if (!ROLES.has(role)) throw new Error(`Doplněk č. ${index + 1} má neplatnou úlohu.`);
    return {
      manifestUrl,
      role,
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
      addedAt: typeof item.addedAt === "string" && !Number.isNaN(Date.parse(item.addedAt)) ? item.addedAt : new Date().toISOString(),
      downloadSettings: normalizeDownloadSettings(item.downloadSettings),
    };
  });
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: typeof root.exportedAt === "string" ? root.exportedAt : undefined,
    settings: parseSettings(root.settings),
    addons,
  };
}
