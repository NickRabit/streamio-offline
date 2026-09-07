import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddonRecord } from "./types.js";
import type { AuthState } from "./auth.js";
import { normalizeDownloadSettings } from "./naming.js";
import type { UiLanguage } from "./language.js";

export type TileSize = "compact" | "small" | "medium" | "large";
export interface Settings {
  concurrentDownloads: number; parallelPerProvider: number; uiLanguage: UiLanguage; audioLanguage: string; subtitleLanguage: string;
  mergeByName: boolean; streamSort: string; artworkLocation: "data" | "media"; trackProgress: boolean; showResumeRow: boolean;
  /** Artwork is fetched by the server, so no provider ever sees the browser. */
  secureMode: boolean;
  catalogTileSize: TileSize; libraryTileSize: TileSize;
  /** Stored locally; never returned by GET /api/settings. */
  realDebridToken: string;
}
export type PublicSettings = Omit<Settings, "realDebridToken"> & { realDebridConfigured: boolean };

export function publicSettings(settings: Settings): PublicSettings {
  const { realDebridToken: token, ...rest } = settings;
  return { ...rest, realDebridConfigured: Boolean(token) };
}
interface State { addons: AddonRecord[]; settings: Settings; defaultsInstalled: boolean; auth?: AuthState; libraryMeta?: Record<string, { type: string; id: string }>;
  /** Cesty označené jako oblíbené. Nic se nepřesouvá, je to jen příznak. */
  favorites?: string[];
  /** Tituly z katalogu označené hvězdičkou. Vede se zvlášť od cest v knihovně,
   *  protože titul žádný soubor mít nemusí. */
  watchlist?: Record<string, { type: string; id: string; name: string; poster?: string; addedAt: string }>;
  /** Rozkoukané: klíč titulu na pozici v sekundách. */
  progress?: Record<string, { position: number; duration: number; title: string; path?: string; poster?: string; updatedAt: string }> }
const initialState: State = { addons: [], settings: { concurrentDownloads: 1, parallelPerProvider: 1, uiLanguage: "en", audioLanguage: "en", subtitleLanguage: "en", mergeByName: true, streamSort: "recommended", artworkLocation: "data", trackProgress: true, showResumeRow: true, secureMode: true, catalogTileSize: "medium", libraryTileSize: "medium", realDebridToken: "" }, defaultsInstalled: false };

/** Settings written before the interface spoke anything but Czech. Defaulting them
 *  to the new English default would flip a running install on upgrade. */
function migrate(loaded?: Partial<Settings>): Partial<Settings> | undefined {
  if (!loaded || loaded.uiLanguage) return loaded;
  return { ...loaded, uiLanguage: "cs" };
}

export const defaultSettings = (): Settings => structuredClone(initialState.settings);

export class Store {
  private state: State = structuredClone(initialState);
  private readonly filename: string;
  constructor(dataDir = process.env.DATA_DIR ?? "/data") { this.filename = path.join(dataDir, "state.json"); }
  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filename, "utf8")) as Partial<State>;
      this.state = { ...structuredClone(initialState), ...loaded, settings: { ...initialState.settings, ...migrate(loaded.settings) } };
      this.state.addons = this.state.addons.map((addon) => ({ ...addon, downloadSettings: normalizeDownloadSettings(addon.downloadSettings) }));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  addons() { return this.state.addons; }
  settings() { return this.state.settings; }
  defaultsInstalled() { return this.state.defaultsInstalled; }
  auth() { return this.state.auth; }
  libraryMeta() { return this.state.libraryMeta ?? {}; }
  favorites() { return this.state.favorites ?? []; }
  progress() { return this.state.progress ?? {}; }
  watchlist() { return this.state.watchlist ?? {}; }
  private chain: Promise<void> = Promise.resolve();
  /** Zápisy jdou za sebou, jinak si dvě souběžná uložení přeberou stejný .tmp soubor. */
  async update(mutator: (state: State) => void) {
    mutator(this.state);
    this.chain = this.chain.then(async () => {
      const temp = `${this.filename}.tmp`;
      await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await rename(temp, this.filename);
    });
    return this.chain;
  }
}
