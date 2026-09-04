import { execFile } from "node:child_process";
import { access, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";
import { guardedFetch } from "./outbound.js";

const run = promisify(execFile);

/** Jména, pod kterými hledá obrázky Emby i Jellyfin. Pořadí určuje přednost. */
export const POSTER_NAMES = ["poster.jpg", "poster.png", "folder.jpg", "folder.png", "cover.jpg", "cover.png", "default.jpg"];
export const BACKDROP_NAMES = ["backdrop.jpg", "fanart.jpg", "background.jpg"];
/** Náš výstup. Jellyfin ho při skenu převezme jako plakát. */
export const POSTER_OUTPUT = "poster.jpg";

/** Náhled epizody hledá Jellyfin pod jménem souboru; my píšeme stejně. */
export const episodeArtName = (videoFile: string) => `${videoFile.replace(/\.[^.]+$/, "")}.jpg`;

const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };

/** Vrátí jméno existujícího obrázku ve složce, ať už ho vyrobil kdokoli. */
export async function findArtwork(directory: string, names = POSTER_NAMES): Promise<string | undefined> {
  let entries: string[];
  try { entries = await readdir(directory); } catch { return undefined; }
  const lower = new Map(entries.map((name) => [name.toLowerCase(), name]));
  for (const candidate of names) {
    const found = lower.get(candidate);
    if (found) return found;
  }
  return undefined;
}

/** Zápis přes dočasný soubor, ať se nikdy neobjeví poloviční obrázek. */
async function writeAtomic(target: string, data: Buffer) {
  const temp = `${target}.tmp`;
  await writeFile(temp, data, { mode: 0o644 });
  await rename(temp, target);
}

/** Stáhne obrázek na přesné místo. Používá se pro plakát, který klient poslal z katalogu. */
export async function savePosterAs(target: string, url: string): Promise<boolean> {
  try {
    const response = await guardedFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return false;
    if (!(response.headers.get("content-type") ?? "").startsWith("image/")) return false;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) return false;
    await writeAtomic(target, data);
    return true;
  } catch { return false; }
}

export async function savePosterFromUrl(directory: string, url: string): Promise<boolean> {
  try {
    const response = await guardedFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return false;
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return false;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) return false;
    await writeAtomic(path.join(directory, POSTER_OUTPUT), data);
    return true;
  } catch { return false; }
}

/**
 * Snímek z videa. Filtr thumbnail vybere reprezentativní obrázek z padesáti,
 * což stojí prakticky totéž co jeden slepý snímek, ale nevrací černou plochu.
 */
export async function saveFrame(videoPath: string, target: string, seconds = 300): Promise<boolean> {
  const temp = `${target}.tmp.jpg`;
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-ss", String(seconds), "-i", videoPath,
      "-vf", "thumbnail=50,scale=480:-2", "-frames:v", "1", "-q:v", "4", "-y", temp,
    ], { timeout: 60_000 });
    await rename(temp, target);
    return true;
  } catch (error) {
    log("WARN", "The thumbnail could not be generated", { file: path.basename(videoPath), reason: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    return false;
  }
}

/** Krátká videa nemají pátou minutu; bereme zhruba třetinu stopáže. */
export const framePosition = (duration?: number) => {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return 300;
  return Math.max(1, Math.min(300, Math.floor(duration / 3)));
};

/** Jeden běh naráz. Na Celeronu je generování náhledů to nejdražší, co server dělá. */
export class ArtworkQueue {
  private pending = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  run(key: string, task: () => Promise<void>) {
    if (this.pending.has(key)) return this.chain;
    this.pending.add(key);
    this.chain = this.chain
      .then(task)
      .catch((error) => log("WARN", "The artwork job failed", { key, reason: String(error).slice(0, 120) }))
      .finally(() => { this.pending.delete(key); });
    return this.chain;
  }
  get size() { return this.pending.size; }
}
