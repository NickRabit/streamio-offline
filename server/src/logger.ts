import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

let chain = Promise.resolve();
let filename = path.join(process.env.DATA_DIR ?? "/data", "app.log");
export function initLogger(dataDir = process.env.DATA_DIR ?? "/data") { filename = path.join(dataDir, "app.log"); return mkdir(dataDir, { recursive: true }); }
export function log(level: "INFO" | "WARN" | "ERROR", message: string, context?: Record<string, unknown>) {
  const line = `${new Date().toISOString()} ${level} ${message}${context ? ` ${JSON.stringify(context)}` : ""}\n`;
  chain = chain.then(() => appendFile(filename, line, { mode: 0o600 })).catch(() => undefined);
}
export async function readLog() { try { return await readFile(filename, "utf8"); } catch { return "Log zatím neobsahuje žádné záznamy.\n"; } }
