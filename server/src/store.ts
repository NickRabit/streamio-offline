import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddonRecord } from "./types.js";

interface State { addons: AddonRecord[]; settings: { concurrentDownloads: number }; defaultsInstalled: boolean }
const initialState: State = { addons: [], settings: { concurrentDownloads: 1 }, defaultsInstalled: false };

export class Store {
  private state: State = structuredClone(initialState);
  private readonly filename: string;
  constructor(dataDir = process.env.DATA_DIR ?? "/data") { this.filename = path.join(dataDir, "state.json"); }
  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try { this.state = { ...structuredClone(initialState), ...JSON.parse(await readFile(this.filename, "utf8")) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  addons() { return this.state.addons; }
  settings() { return this.state.settings; }
  defaultsInstalled() { return this.state.defaultsInstalled; }
  async update(mutator: (state: State) => void) {
    mutator(this.state);
    const temp = `${this.filename}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temp, this.filename);
  }
}
