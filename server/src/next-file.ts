import path from "node:path";
import { readdir } from "node:fs/promises";
import { isVideo } from "./library.js";

export async function nextVideoFile(file: string, direction: -1 | 1 = 1): Promise<string | undefined> {
  const files = (await readdir(path.dirname(file), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && isVideo(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || a.localeCompare(b, "en"));
  const index = files.indexOf(path.basename(file));
  return index >= 0 && index + direction >= 0 && index + direction < files.length ? files[index + direction] : undefined;
}
