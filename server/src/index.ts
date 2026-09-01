import express from "express";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadAddon, catalog, metadata, searchAll, searchableCatalogs, streamCandidates, streams, subtitles } from "./addons.js";
import { rankStreams } from "./ranking.js";
import { DownloadQueue } from "./downloads.js";
import { PlaybackManager } from "./playback.js";
import { publicAddon, safeFetch, validateRemoteUrl } from "./security.js";
import { Store } from "./store.js";
import { initLogger, log, readLog } from "./logger.js";
import { clearedCookie, createSession, pruneRevoked, DEFAULT_PASSWORD, DEFAULT_USERNAME, envCredentials, hashPassword, INTERNAL_TOKEN, parseCookies, readSession, REMEMBER_DAYS, SESSION_COOKIE, sessionCookie, verifyPassword } from "./auth.js";
import { randomBytes } from "node:crypto";
import type { ClientCapabilities, PlaybackOptions } from "./playback.js";
import type { MediaInfo } from "./naming.js";
import { defaultDownloadSettings, normalizeDownloadSettings } from "./naming.js";
import { LANGUAGE_NAMES, normalizeLanguage } from "./language.js";
import type { AddonRole, StreamItem } from "./types.js";

const STREAM_SORTS = new Set(["recommended", "size-desc", "size-asc", "addon"]);
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
// Výběr zdroje pro líné úlohy fronty: doplňky se ptáme až v okamžiku stahování a odpověď
// chvíli držíme, aby opakované pokusy téže epizody nebušily do doplňků znovu a znovu.
const streamCache = new Map<string, { at: number; items: StreamItem[] }>();
const cachedStreams = async (type: string, id: string) => {
  const key = `${type}:${id}`;
  const hit = streamCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.items;
  const items = await streams(store.addons(), type, id);
  if (streamCache.size > 100) streamCache.clear();
  streamCache.set(key, { at: Date.now(), items });
  return items;
};
queue.setResolver(async (type, videoId, tried) => {
  const priority = new Map(store.addons().map((addon, index) => [addon.key, index]));
  const candidates = (await cachedStreams(type, videoId)).filter((stream) => stream.url);
  const ranked = rankStreams(candidates, store.settings().audioLanguage, priority);
  const next = ranked.find((stream) => !tried.includes(stream.url!));
  if (!next) return undefined;
  const addon = store.addons().find((item) => item.key === next.addonKey);
  return { stream: next, settings: addon?.downloadSettings ?? defaultDownloadSettings() };
});
await queue.load();
await playback.load();

// Výchozí přihlášení vznikne při prvním startu; heslo se ukládá jen jako otisk.
if (!store.auth()) {
  const passwordHash = await hashPassword(DEFAULT_PASSWORD);
  await store.update((state) => { state.auth = { username: DEFAULT_USERNAME, passwordHash, secret: randomBytes(32).toString("hex"), isDefault: true }; });
  log("WARN", "Vytvořeno výchozí přihlášení admin/admin, změňte ho prosím v Nastavení");
}
const secret = () => store.auth()!.secret;
const isSecure = (req: express.Request) => req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
const knownUser = (name: string) => name === store.auth()!.username || name === envCredentials()?.username;
const currentSession = (req: express.Request) => {
  const info = readSession(secret(), parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!info || !knownUser(info.username)) return undefined;
  // Odhlášená relace je neplatná i s dosud platným podpisem.
  return store.auth()!.revoked?.[info.sid] ? undefined : info;
};
const currentUser = (req: express.Request) => currentSession(req)?.username;
const mustChangePassword = () => store.auth()!.isDefault;

app.use(express.json({ limit: "256kb" }));
const asyncRoute = (fn: express.RequestHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

// Bez přihlášení je otevřený jen stav serveru a samotné přihlášení. Zvlášť /api/proxy
// nesmí být veřejné, jinak přes něj kdokoli tahá cizí adresy přes tenhle server.
const OPEN_PATHS = new Set(["/status", "/auth/login", "/auth/me"]);
app.use("/api", (req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (typeof req.query.token === "string" && req.query.token === INTERNAL_TOKEN) return next();
  if (!currentUser(req)) return res.status(401).json({ error: "Nepřihlášeno." });
  // Dokud běží výchozí heslo, pustíme jen změnu údajů. Jinak by admin/admin mohlo zůstat napořád.
  if (mustChangePassword() && !req.path.startsWith("/auth")) {
    return res.status(403).json({ error: "Nejdřív si prosím nastavte vlastní heslo.", code: "PASSWORD_CHANGE_REQUIRED" });
  }
  next();
});

app.get("/api/auth/me", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Nepřihlášeno." });
  res.json({ username: user, mustChangePassword: mustChangePassword() });
});
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const username = String(req.body.username ?? "");
  const password = String(req.body.password ?? "");
  const remember = Boolean(req.body.remember);
  const stored = store.auth()!;
  const fromEnv = envCredentials();
  const bySettings = username === stored.username && await verifyPassword(password, stored.passwordHash);
  const byEnv = Boolean(fromEnv && username === fromEnv.username && password === fromEnv.password);
  if (!bySettings && !byEnv) { log("WARN", "Neúspěšné přihlášení", { username }); return res.status(401).json({ error: "Nesprávné jméno nebo heslo." }); }
  const expiresAt = Date.now() + (remember ? REMEMBER_DAYS : 1) * 24 * 60 * 60 * 1000;
  res.setHeader("set-cookie", sessionCookie(createSession(secret(), username, expiresAt), remember, isSecure(req)));
  log("INFO", "Přihlášení", { username, remember, zaloznimiUdaji: byEnv && !bySettings });
  res.json({ username, mustChangePassword: mustChangePassword() });
}));
app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const info = currentSession(req);
  res.setHeader("set-cookie", clearedCookie());
  if (!info) return res.status(204).end();
  if (req.body?.everywhere) {
    // Nové tajemství zneplatní všechny dosud vydané známky naráz.
    const nextSecret = randomBytes(32).toString("hex");
    await store.update((state) => { state.auth = { ...state.auth!, secret: nextSecret, revoked: {} }; });
    log("INFO", "Odhlášena všechna zařízení", { username: info.username });
  } else {
    await store.update((state) => {
      state.auth = { ...state.auth!, revoked: { ...pruneRevoked(state.auth!.revoked), [info.sid]: info.expiresAt } };
    });
    log("INFO", "Odhlášení", { username: info.username });
  }
  res.status(204).end();
}));
app.patch("/api/auth/password", asyncRoute(async (req, res) => {
  // U vynucené první změny stačí platná relace: uživatel se právě prokázal výchozím heslem.
  if (!mustChangePassword()) {
    const current = String(req.body.currentPassword ?? "");
    if (!await verifyPassword(current, store.auth()!.passwordHash)) throw new Error("Stávající heslo nesouhlasí.");
  }
  const nextPassword = String(req.body.newPassword ?? "");
  if (nextPassword.length < 6) throw new Error("Nové heslo musí mít aspoň 6 znaků.");
  const username = String(req.body.username ?? store.auth()!.username).trim() || store.auth()!.username;
  const passwordHash = await hashPassword(nextPassword);
  // Nové tajemství zneplatní všechny dosud vydané známky, včetně cizích zařízení.
  const nextSecret = randomBytes(32).toString("hex");
  await store.update((state) => { state.auth = { username, passwordHash, secret: nextSecret, isDefault: false, revoked: {} }; });
  res.setHeader("set-cookie", sessionCookie(createSession(nextSecret, username, Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000), true, isSecure(req)));
  log("INFO", "Změněny přihlašovací údaje", { username });
  res.json({ username, mustChangePassword: false });
}));

app.get("/api/status", (_req, res) => res.json({ status: "ok", version: "0.3.0" }));
app.get("/api/addons", (_req, res) => res.json(store.addons().map(publicAddon)));
app.post("/api/addons", asyncRoute(async (req, res) => {
  const role = (["catalog", "source", "both"].includes(req.body.role) ? req.body.role : "both") as AddonRole;
  const addon = await loadAddon(String(req.body.url ?? ""), role);
  if (store.addons().some((item) => item.manifest.id === addon.manifest.id && item.manifestUrl === addon.manifestUrl)) throw new Error("Tento manifest už je přidaný.");
  await store.update((state) => state.addons.push(addon)); res.status(201).json(publicAddon(addon));
}));
// Pořadí doplňků je zároveň jejich priorita při řazení zdrojů.
app.post("/api/addons/:key/move", asyncRoute(async (req, res) => {
  const direction = Number(req.body.direction) < 0 ? -1 : 1;
  await store.update((state) => {
    const index = state.addons.findIndex((addon) => addon.key === req.params.key);
    if (index < 0) throw new Error("Doplněk nebyl nalezen.");
    const next = Math.max(0, Math.min(state.addons.length - 1, index + direction));
    if (next === index) return;
    const [addon] = state.addons.splice(index, 1);
    state.addons.splice(next, 0, addon);
  });
  res.status(204).end();
}));
app.delete("/api/addons/:key", asyncRoute(async (req, res) => { await store.update((state) => { state.addons = state.addons.filter((a) => a.key !== req.params.key); }); res.status(204).end(); }));
// Úplný záznam včetně adresy s tokenem. Rozhraní ji jinak skrývá, tady je vydání záměrné.
app.get("/api/addons/:key/export", asyncRoute(async (req, res) => {
  const addon = store.addons().find((a) => a.key === req.params.key);
  if (!addon) throw new Error("Doplněk nebyl nalezen.");
  res.json({ manifestUrl: addon.manifestUrl, role: addon.role, enabled: addon.enabled, addedAt: addon.addedAt, downloadSettings: addon.downloadSettings, manifest: addon.manifest });
}));
app.patch("/api/addons/:key", asyncRoute(async (req, res) => {
  const existing = store.addons().find((a) => a.key === req.params.key);
  if (!existing) throw new Error("Doplněk nebyl nalezen.");
  const role = ["catalog", "source", "both"].includes(req.body.role) ? req.body.role as AddonRole : existing.role;
  // Jiná adresa znamená načíst manifest znovu. Klíč, pořadí i nastavení ukládání zůstávají,
  // takže po překonfigurování doplňku není nutné ho mazat a přidávat.
  const url = req.body.url === undefined ? undefined : String(req.body.url).trim();
  const reloaded = url && url !== existing.manifestUrl ? await loadAddon(url, role) : undefined;
  await store.update((state) => {
    const addon = state.addons.find((a) => a.key === req.params.key);
    if (!addon) throw new Error("Doplněk nebyl nalezen.");
    if (typeof req.body.enabled === "boolean") addon.enabled = req.body.enabled;
    if (req.body.downloadSettings !== undefined) addon.downloadSettings = normalizeDownloadSettings(req.body.downloadSettings);
    addon.role = role;
    if (reloaded) { addon.manifestUrl = reloaded.manifestUrl; addon.manifest = reloaded.manifest; }
  });
  if (reloaded) log("INFO", "Doplněk překonfigurován", { name: reloaded.manifest.name, role });
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
app.get("/api/stream-sources/:type/:id", (req, res) => res.json(
  streamCandidates(store.addons(), String(req.params.type), String(req.params.id)).map((addon) => ({ key: addon.key, name: addon.manifest.name }))));
app.get("/api/streams/:type/:id", asyncRoute(async (req, res) => res.json(
  await streams(store.addons(), String(req.params.type), String(req.params.id), req.query.addon ? String(req.query.addon) : undefined))));
app.get("/api/subtitles/:type/:id", asyncRoute(async (req, res) => res.json(await subtitles(store.addons(), String(req.params.type), String(req.params.id)))));
app.get("/api/subtitle", asyncRoute(async (req, res) => {
  const raw = String(req.query.url ?? ""); await validateRemoteUrl(raw); const response = await safeFetch(raw, { signal: AbortSignal.timeout(20_000) }); if (!response.ok) throw new Error(`Titulky odpověděly HTTP ${response.status}.`);
  let text = await response.text(); if (!text.trimStart().startsWith("WEBVTT")) text = `WEBVTT\n\n${text.replace(/^\ufeff/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
  const offset = Number(req.query.offset) || 0; if (offset) text = shiftVtt(text, offset);
  res.type("text/vtt; charset=utf-8").setHeader("cache-control", "private, max-age=3600").send(text);
}));
app.get("/api/downloads", (_req, res) => res.json(queue.list()));
app.post("/api/downloads", asyncRoute(async (req, res) => {
  const stream = req.body.stream as StreamItem;
  const media = req.body.media as MediaInfo | undefined;
  const addon = store.addons().find((item) => item.key === stream.addonKey);
  const settings = addon?.downloadSettings ?? defaultDownloadSettings();
  const targetSettings = media?.kind === "episode" ? settings.series : settings.movie;
  res.status(201).json(await queue.add(String(req.body.title ?? "video"), stream, media, targetSettings));
}));
// Hromadné přidání epizod: úlohy jsou líné, streamy se u doplňků poptají až při stahování.
app.post("/api/downloads/bulk", asyncRoute(async (req, res) => {
  const title = String(req.body.title ?? "").trim() || "Seriál";
  const type = String(req.body.type ?? "series");
  const episodes = Array.isArray(req.body.episodes) ? req.body.episodes as Array<Record<string, unknown>> : [];
  if (!episodes.length) throw new Error("Chybí seznam epizod.");
  if (episodes.length > 500) throw new Error("Najednou lze přidat nejvýše 500 epizod.");
  let added = 0, skipped = 0;
  for (const episode of episodes) {
    const videoId = String(episode.id ?? "").trim();
    if (!videoId) { skipped += 1; continue; }
    const season = episode.season == null ? undefined : Number(episode.season);
    const number = episode.episode == null ? undefined : Number(episode.episode);
    const episodeTitle = episode.title ? String(episode.title) : undefined;
    const jobTitle = `${title} · ${episodeTitle ?? (season != null ? `S${String(season).padStart(2, "0")}E${String(number ?? 0).padStart(2, "0")}` : `Díl ${number ?? "?"}`)}`;
    const media: MediaInfo = { kind: "episode", title, season, episode: number, episodeTitle };
    const job = await queue.addPending(jobTitle, { type, videoId }, media);
    if (job) added += 1; else skipped += 1;
  }
  log("INFO", "Hromadné přidání do fronty", { title, added, skipped });
  res.status(201).json({ added, skipped });
}));
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
    if (req.body.streamSort !== undefined) {
      const value = String(req.body.streamSort);
      state.settings.streamSort = STREAM_SORTS.has(value) ? value : "recommended";
    }
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
  if (req.body.time !== undefined) options.startTime = Math.max(0, Number(req.body.time) || 0);
  if (req.body.quality !== undefined) options.quality = req.body.quality === null ? null : Number(req.body.quality);
  res.status(201).json(await playback.start(req.body.stream as StreamItem, req.body.capabilities as ClientCapabilities, options));
}));
app.post("/api/playback/:id/seek", asyncRoute(async (req, res) => res.json(await playback.seek(String(req.params.id), Number(req.body.time) || 0))));
app.post("/api/playback/:id/track", asyncRoute(async (req, res) => res.json(await playback.track(String(req.params.id), {
  audio: req.body.audio === undefined ? undefined : Number(req.body.audio),
  subtitle: req.body.subtitle === undefined ? undefined : (req.body.subtitle === null ? null : Number(req.body.subtitle)),
  quality: req.body.quality === undefined ? undefined : (req.body.quality === null ? null : Number(req.body.quality)),
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
