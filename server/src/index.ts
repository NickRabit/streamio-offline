import express from "express";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadAddon, catalog, metadata, streams, subtitles } from "./addons.js";
import { DownloadQueue } from "./downloads.js";
import { publicAddon, safeFetch, validateRemoteUrl } from "./security.js";
import { Store } from "./store.js";
import type { AddonRole, StreamItem } from "./types.js";

const app = express(); const store = new Store(); const queue = new DownloadQueue();
await store.load();
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
app.use(express.json({ limit: "256kb" }));
const asyncRoute = (fn: express.RequestHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

app.get("/api/status", (_req, res) => res.json({ status: "ok", version: "0.1.0" }));
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
  res.json(await catalog(addon, String(req.query.type), String(req.query.id), req.query.search ? String(req.query.search) : undefined, Number(req.query.skip) || 0));
}));
app.get("/api/meta/:type/:id", asyncRoute(async (req, res) => { const meta = await metadata(store.addons(), String(req.params.type), String(req.params.id)); if (!meta) return res.status(404).json({ error: "Metadata nebyla nalezena." }); res.json(meta); }));
app.get("/api/streams/:type/:id", asyncRoute(async (req, res) => res.json(await streams(store.addons(), String(req.params.type), String(req.params.id)))));
app.get("/api/subtitles/:type/:id", asyncRoute(async (req, res) => res.json(await subtitles(store.addons(), String(req.params.type), String(req.params.id)))));
app.get("/api/downloads", (_req, res) => res.json(queue.list()));
app.post("/api/downloads", asyncRoute(async (req, res) => res.status(201).json(await queue.add(String(req.body.title ?? "video"), req.body.stream as StreamItem))));

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

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
app.use(express.static(webRoot)); app.get("/{*path}", (_req, res) => res.sendFile(path.join(webRoot, "index.html")));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error(error); res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); });
app.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => console.log("Stremio Offline běží na portu 8080"));
