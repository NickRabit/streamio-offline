import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddonRecord } from "./types.js";
import type { AuthState } from "./auth.js";
import { normalizeDownloadSettings } from "./naming.js";

export type TileSize = "compact" | "small" | "medium" | "large";
interface Settings { concurrentDownloads: number; audioLanguage: string; subtitleLanguage: string; mergeByName: boolean; streamSort: string; artworkLocation: "data" | "media"; trackProgress: boolean; showResumeRow: boolean; catalogTileSize: TileSize; libraryTileSize: TileSize }
interface State { addons: AddonRecord[]; settings: Settings; defaultsInstalled: boolean; auth?: AuthState; libraryMeta?: Record<string, { type: string; id: string }>;
  /** Cesty označené jako oblíbené. Nic se nepřesouvá, je to jen příznak. */
  favorites?: string[];
  /** Tituly z katalogu označené hvězdičkou. Vede se zvlášť od cest v knihovně,
   *  protože titul žádný soubor mít nemusí. */
  watchlist?: Record<string, { type: string; id: string; name: string; poster?: string; addedAt: string }>;
  /** Rozkoukané: klíč titulu na pozici v sekundách. */
  progress?: Record<string, { position: number; duration: number; title: string; path?: string; poster?: string; updatedAt: string }> }
const initialState: State = { addons: [], settings: { concurrentDownloads: 1, audioLanguage: "cs", subtitleLanguage: "cs", mergeByName: true, streamSort: "recommended", artworkLocation: "data", trackProgress: true, showResumeRow: true, catalogTileSize: "medium", libraryTileSize: "medium" }, defaultsInstalled: false };

export class Store {
  private state: State = structuredClone(initialState);
  private readonly filename: string;
  constructor(dataDir = process.env.DATA_DIR ?? "/data") { this.filename = path.join(dataDir, "state.json"); }
  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filename, "utf8")) as Partial<State>;
      this.state = { ...structuredClone(initialState), ...loaded, settings: { ...initialState.settings, ...loaded.settings } };
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
