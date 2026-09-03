import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Which image is this? Without it a log tells us nothing about the code that wrote it,
 * so the values are baked in at build time and reported wherever they help:
 * the startup line, /api/status and the settings page. */
export interface BuildInfo { version: string; builtAt?: string; commit?: string }

const version = () => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version as string;
  } catch { return "0.0.0"; }
};

// Empty for a plain "docker build" without --build-arg; the fields are then simply omitted.
const clean = (value?: string) => value && value.trim() ? value.trim() : undefined;

export const build: BuildInfo = {
  version: version(),
  builtAt: clean(process.env.BUILD_TIME),
  commit: clean(process.env.GIT_COMMIT),
};

/** Short form for the log line and the interface: 2026-09-03 12:40 · a1b2c3d */
export const describeBuild = () => [build.version, build.builtAt, build.commit].filter(Boolean).join(" · ");
