import express from "express";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadAddon, catalog, metadata, searchAll, searchableCatalogs, streams, subtitles } from "./addons.js";
import { DownloadQueue } from "./downloads.js";
import { PlaybackManager } from "./playback.js";
import { publicAddon, safeFetch, validateRemoteUrl } from "./security.js";
import { Store } from "./store.js";
import { initLogger, log, readLog } from "./logger.js";
import type { ClientCapabilities, PlaybackOptions } from "./playback.js";
import type { MediaInfo } from "./naming.js";
import { LANGUAGE_NAMES, normalizeLanguage } from "./language.js";
import type { AddonRole, StreamItem } from "./types.js";

const app = express(); const store = new Store();
await store.load();
await initLogger(); log("INFO", "Server startuje", { version: "0.3.0" });
const queue = new DownloadQueue(() => store.settings().concurrentDownloads); const playback = new PlaybackManager();
if (!store.defaultsInstalled()) {
  const defaults = [
    { url: "https://v3-cinemeta.strem.io/manifest.json", role: "catalog" as const },
    { url: "https://opensubtitles-v3.strem.io/manifest.json", role: "source" as const },
  ];
  const loaded = await Promise.allSettled(defaults.filter((item) => !store.addons().some((addon) => addon.manifestUrl === item.url)).map((item) => loadAddon(item.url, item.role)));
  await store.update((state) => {
    for (const result of loaded) if (result.status === "fulfilled") state.addons.push(result.value);
    state.defaultsInstalled = defaults.every((item) => state.addons.some((addon) => addon.manifestUrl === item.url));
  });
}
await queue.load();
await playback.load();
app.use(express.json({ limit: "256kb" }));
const asyncRoute = (fn: express.RequestHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

app.get("/api/status", (_req, res) => res.json({ status: "ok", version: "0.3.0" }));
app.get("/api/addons", (_req, res) => res.json(store.addons().map(publicAddon)));
app.post("/api/addons", asyncRoute(async (req, res) => {
  const role = (["catalog", "source", "both"].includes(req.body.role) ? req.body.role : "both") as AddonRole;
  const addon = await loadAddon(String(req.body.url ?? ""), role);
  if (store.addons().some((item) => item.manifest.id === addon.manifest.id && item.manifestUrl === addon.manifestUrl)) throw new Error("Tento manifest už je přidaný.");
  await store.update((state) => state.addons.push(addon)); res.status(201).json(publicAddon(addon));
}));
app.delete("/api/addons/:key", asyncRoute(async (req, res) => { await store.update((state) => { state.addons = state.addons.filter((a) => a.key !== req.params.key); }); res.status(204).end(); }));
app.patch("/api/addons/:key", asyncRoute(async (req, res) => {
  await store.update((state) => { const addon = state.addons.find((a) => a.key === req.params.key); if (!addon) throw new Error("Doplněk nebyl nalezen."); if (typeof req.body.enabled === "boolean") addon.enabled = req.body.enabled; });
  res.json(publicAddon(store.addons().find((a) => a.key === req.params.key)!));
}));
app.get("/api/catalogs", (_req, res) => res.json(store.addons().filter((a) => a.enabled && a.role !== "source").flatMap((addon) => (addon.manifest.catalogs ?? []).map((item) => ({ ...item, addonKey: addon.key, addonName: addon.manifest.name })) )));
app.get("/api/catalog", asyncRoute(async (req, res) => {
  const addon = store.addons().find((a) => a.key === req.query.addon); if (!addon) throw new Error("Doplněk nebyl nalezen.");
  res.json(await catalog(addon, String(req.query.type), String(req.query.id), req.query.search ? String(req.query.search) : undefined, Number(req.query.skip) || 0, req.query.genre ? String(req.query.genre) : undefined));
}));
app.get("/api/search", asyncRoute(async (req, res) => {
  const query = String(req.query.query ?? "").trim();
  if (!query) throw new Error("Zadejte hledaný výraz.");
  const type = req.query.type ? String(req.query.type) : undefined;
  res.json(await searchAll(store.addons(), query, type, req.query.cursor ? String(req.query.cursor) : undefined, req.query.addon ? String(req.query.addon) : undefined));
}));
app.get("/api/searchable", (_req, res) => res.json(searchableCatalogs(store.addons()).map(({ addon, definition }) => ({ addonKey: addon.key, addonName: addon.manifest.name, type: definition.type, id: definition.id }))));
app.get("/api/meta/:type/:id", asyncRoute(async (req, res) => { const meta = await metadata(store.addons(), String(req.params.type), String(req.params.id)); if (!meta) return res.status(404).json({ error: "Metadata nebyla nalezena." }); res.json(meta); }));
app.get("/api/streams/:type/:id", asyncRoute(async (req, res) => res.json(await streams(store.addons(), String(req.params.type), String(req.params.id)))));
app.get("/api/subtitles/:type/:id", asyncRoute(async (req, res) => res.json(await subtitles(store.addons(), String(req.params.type), String(req.params.id)))));
app.get("/api/subtitle", asyncRoute(async (req, res) => {
  const raw = String(req.query.url ?? ""); await validateRemoteUrl(raw); const response = await safeFetch(raw, { signal: AbortSignal.timeout(20_000) }); if (!response.ok) throw new Error(`Titulky odpověděly HTTP ${response.status}.`);
  let text = await response.text(); if (!text.trimStart().startsWith("WEBVTT")) text = `WEBVTT\n\n${text.replace(/^\ufeff/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
  const offset = Number(req.query.offset) || 0; if (offset) text = shiftVtt(text, offset);
  res.type("text/vtt; charset=utf-8").setHeader("cache-control", "private, max-age=3600").send(text);
}));
app.get("/api/downloads", (_req, res) => res.json(queue.list()));
app.post("/api/downloads", asyncRoute(async (req, res) => res.status(201).json(await queue.add(String(req.body.title ?? "video"), req.body.stream as StreamItem, req.body.media as MediaInfo | undefined))));
app.post("/api/downloads/:id/pause", asyncRoute(async (req, res) => { await queue.pause(String(req.params.id)); res.status(204).end(); }));
app.post("/api/downloads/:id/resume", asyncRoute(async (req, res) => { await queue.resume(String(req.params.id)); res.status(204).end(); }));
app.post("/api/downloads/:id/retry", asyncRoute(async (req, res) => { await queue.retry(String(req.params.id)); res.status(204).end(); }));
app.post("/api/downloads/:id/move", asyncRoute(async (req, res) => { await queue.move(String(req.params.id), Number(req.body.direction) < 0 ? -1 : 1); res.status(204).end(); }));
app.delete("/api/downloads/:id", asyncRoute(async (req, res) => { await queue.remove(String(req.params.id)); res.status(204).end(); }));
app.delete("/api/downloads", asyncRoute(async (_req, res) => { await queue.clearCompleted(); res.status(204).end(); }));
app.get("/api/settings", (_req, res) => res.json(store.settings()));
app.get("/api/logs", asyncRoute(async (_req, res) => { res.type("text/plain; charset=utf-8").setHeader("content-disposition", "attachment; filename=stremio-offline.log").send(await readLog()); }));
app.patch("/api/settings", asyncRoute(async (req, res) => {
  await store.update((state) => {
    if (req.body.concurrentDownloads !== undefined) state.settings.concurrentDownloads = Math.max(1, Math.min(8, Number(req.body.concurrentDownloads) || 1));
    if (req.body.audioLanguage !== undefined) state.settings.audioLanguage = normalizeLanguage(String(req.body.audioLanguage)) ?? "cs";
    if (req.body.subtitleLanguage !== undefined) state.settings.subtitleLanguage = normalizeLanguage(String(req.body.subtitleLanguage)) ?? "cs";
    if (req.body.mergeByName !== undefined) state.settings.mergeByName = Boolean(req.body.mergeByName);
  });
  queue.changed(); res.json(store.settings());
}));
app.get("/api/languages", (_req, res) => res.json(Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name }))));
app.post("/api/inspect", asyncRoute(async (req, res) => {
  const info = await playback.inspect(req.body.stream as StreamItem);
  res.json({ duration: info?.duration, video: info?.video, audioTracks: info?.audioTracks ?? [], subtitleTracks: info?.subtitleTracks ?? [] });
}));
app.post("/api/playback", asyncRoute(async (req, res) => {
  const settings = store.settings();
  const options: PlaybackOptions = { audioLanguage: settings.audioLanguage, subtitleLanguage: settings.subtitleLanguage };
  if (req.body.audioTrack !== undefined) options.audioTrack = Number(req.body.audioTrack);
  if (req.body.subtitleTrack !== undefined) options.subtitleTrack = req.body.subtitleTrack === null ? null : Number(req.body.subtitleTrack);
  res.status(201).json(await playback.start(req.body.stream as StreamItem, req.body.capabilities as ClientCapabilities, options));
}));
app.post("/api/playback/:id/seek", asyncRoute(async (req, res) => res.json(await playback.seek(String(req.params.id), Number(req.body.time) || 0))));
app.post("/api/playback/:id/track", asyncRoute(async (req, res) => res.json(await playback.track(String(req.params.id), {
  audio: req.body.audio === undefined ? undefined : Number(req.body.audio),
  subtitle: req.body.subtitle === undefined ? undefined : (req.body.subtitle === null ? null : Number(req.body.subtitle)),
  time: Number(req.body.time) || 0,
}))));
app.delete("/api/playback/:id", asyncRoute(async (req, res) => { await playback.stop(String(req.params.id)); res.status(204).end(); }));
app.get("/api/playback/:id/:generation/:file", asyncRoute(async (req, res) => {
  const directory = playback.directory(String(req.params.id), String(req.params.generation)); if (!directory) return res.status(404).end(); const file = String(req.params.file);
  // Bez lomítek a teček nemůže jméno utéct z adresáře relace.
  if (!/^[A-Za-z0-9_-]{1,64}\.(m3u8|mp4|m4s|vtt)$/.test(file)) return res.status(400).end();
  if (file === "master.m3u8") {
    // FFmpeg píše HEVC jako hvc1.1.4.L120.B01, jenže prohlížeče uznávají jen tvar B0 a hls.js
    // podle toho stream odmítne dřív, než ho zkusí. Bez atributu si kodeky odvodí z init segmentu.
    const playlist = await readFile(path.join(directory, file), "utf8");
    return void res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "no-store")
      .send(playlist.replace(/CODECS="[^"]*"/g, "").replace(/:,+/g, ":").replace(/,{2,}/g, ",").replace(/,\s*$/gm, ""));
  }
  if (file.endsWith(".m3u8")) res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "no-store");
  else { if (file.endsWith(".vtt")) res.type("text/vtt; charset=utf-8"); res.setHeader("cache-control", "public, max-age=3600"); }
  res.sendFile(path.join(directory, file), (error) => { if (error && !res.headersSent) res.status(404).end(); });
}));

app.get("/api/proxy", asyncRoute(async (req, res) => {
  const raw = String(req.query.url ?? ""); await validateRemoteUrl(raw);
  const streamHeaders = typeof req.query.headers === "string" ? JSON.parse(Buffer.from(req.query.headers, "base64url").toString()) : {};
  const headers: Record<string, string> = { ...streamHeaders };
  if (req.headers.range) headers.range = req.headers.range;
  const controller = new AbortController();
  const headerTimeout = setTimeout(() => controller.abort(), 30_000);
  let upstream: Response;
  try { upstream = await safeFetch(raw, { headers, signal: controller.signal }); }
  finally { clearTimeout(headerTimeout); }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("mpegurl") || new URL(upstream.url).pathname.toLowerCase().endsWith(".m3u8")) {
    const headerToken = typeof req.query.headers === "string" ? req.query.headers : undefined;
    const proxied = (value: string) => {
      const params = new URLSearchParams({ url: new URL(value, upstream.url).toString() });
      if (headerToken) params.set("headers", headerToken);
      return `/api/proxy?${params}`;
    };
    const playlist = (await upstream.text()).split(/\r?\n/).map((line) => {
      if (!line) return line;
      if (!line.startsWith("#")) return proxied(line);
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${proxied(uri)}"`);
    }).join("\n");
    res.status(upstream.status).type("application/vnd.apple.mpegurl").setHeader("cache-control", "no-store").send(playlist);
    return;
  }
  res.status(upstream.status);
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
  if (!upstream.body) return res.end();
  const { Readable } = await import("node:stream");
  try { await pipeline(Readable.fromWeb(upstream.body as never), res); }
  catch (error) {
    // Zavření přehrávače nebo seek běžně ukončí předchozí Range požadavek.
    if (!res.destroyed && !res.writableEnded) throw error;
  }
}));

// Po restartu převodu začíná video na nule, takže se o stejnou hodnotu musí posunout i titulky.
const CUE = /(\d{2,}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3}) --> (\d{2,}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/;
const cueSeconds = (value: string) => { const parts = value.split(":").map(Number); return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]; };
const cueStamp = (value: number) => { const total = Math.max(0, value); return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${(total % 60).toFixed(3).padStart(6, "0")}`; };
function shiftVtt(text: string, offset: number) {
  return text.split(/\n\n+/).map((block) => {
    const match = block.match(CUE); if (!match) return block;
    const end = cueSeconds(match[2]) - offset; if (end <= 0) return "";
    return block.replace(CUE, `${cueStamp(cueSeconds(match[1]) - offset)} --> ${cueStamp(end)}`);
  }).filter(Boolean).join("\n\n");
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
app.use(express.static(webRoot)); app.get("/{*path}", (_req, res) => res.sendFile(path.join(webRoot, "index.html")));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error(error); res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); });
process.on("unhandledRejection", (reason) => {
  log("ERROR", "Neošetřené odmítnutí slibu", { reason: reason instanceof Error ? `${reason.message}` : String(reason) });
  console.error("Neošetřené odmítnutí:", reason);
});
app.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => console.log("Stremio Offline běží na portu 8080"));
