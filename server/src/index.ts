import express from "express";
import { mediaResources, ResourceError, safeSourceText, type ResourceOwner } from "./media-resources.js";
import { readMediaText, rewritePlaylist } from "./media-playlist.js";
import path from "node:path";
import { access, mkdir, readdir, readFile, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { loadAddon, catalog, metadata, searchAll, searchableCatalogs, streamCandidates, streams, subtitles } from "./addons.js";
import { rankStreams } from "./ranking.js";
import { DownloadQueue } from "./downloads.js";
import { StatsLog, type TrafficEvent, type TrafficMeta } from "./stats.js";
import { build } from "./build.js";
import { PlaybackManager, sourceTitle } from "./playback.js";
import { publicAddon, redirectedHeaders, safeFetch, upstreamRequestHeaders, validateRemoteUrl } from "./security.js";
import { guardedFetch, outbound } from "./outbound.js";
import { publicSettings, Store } from "./store.js";
import { advanceTorrent, normalizeToken, resolveIfReady, verifyRealDebridToken } from "./debrid.js";
import { clearLog, currentLevel, flushLog, initLogger, log, parseLevel, readLog, startLogMaintenance } from "./logger.js";
import { browseDirectory, describePath, entryDirectory, isPathWithin, orphanedCatalogKeys, pageFiles, remapPath, resolveInside, scanLibrary, sortFiles, summarize } from "./library.js";
import { ArtworkQueue, episodeArtName, findArtwork, framePosition, POSTER_OUTPUT, savePosterAs, savePosterFromUrl, saveFrame } from "./artwork.js";
import { createHash } from "node:crypto";
import { clearedCookie, createSession, DECOY_HASH, LoginThrottle, pruneRevoked, envCredentials, hashPassword, INTERNAL_TOKEN, parseCookies, readSession, secretEquals, REMEMBER_DAYS, SESSION_COOKIE, sessionCookie, verifyPassword } from "./auth.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { ClientCapabilities, PlaybackOptions } from "./playback.js";
import type { MediaInfo } from "./naming.js";
import { defaultDownloadSettings, deviceFilename, normalizeDownloadSettings, safeName } from "./naming.js";
import { LANGUAGE_NAMES, normalizeLanguage } from "./language.js";
import type { AddonRole, MetaItem, StreamItem } from "./types.js";
import { createSettingsBackup, parseSettingsBackup } from "./backup.js";

const STREAM_SORTS = new Set(["recommended", "size-desc", "size-asc", "addon"]);
const app = express(); const store = new Store();
await store.load();
await initLogger(); startLogMaintenance(); log("INFO", "Server starting", { ...build, logLevel: currentLevel() });
const playbackOwners = new Map<string, { owner: ResourceOwner; resourceId: string }>();
const queue = new DownloadQueue(() => store.settings().concurrentDownloads, () => store.settings().parallelPerProvider ?? 1); const playback = new PlaybackManager(undefined, (id) => {
  const owned = playbackOwners.get(id);
  if (owned) {
    mediaResources.remove(owned.resourceId);
    for (const active of activeMedia) if (active.resourceId === owned.resourceId) active.res.destroy();
  }
  playbackOwners.delete(id);
});
const stats = new StatsLog();

/** Poskytovatele bereme z adresy zdroje; doplněk ji může mít u každého streamu jiný. */
const providerOf = (url?: string) => { try { return url ? new URL(url).hostname : "neznámý"; } catch { return "neznámý"; } };

const statMeta = (job: { source?: TrafficMeta["source"]; url?: string; addonKey?: string; addonName?: string; title: string; kind?: string }): TrafficMeta => ({
  source: job.source ?? "download",
  provider: providerOf(job.url),
  addonKey: job.addonKey,
  addonName: job.addonName,
  title: job.title,
  kind: job.kind === "movie" || job.kind === "episode" ? job.kind : "other",
});

const statEvent = (job: { at: string; bytes: number; url?: string; addonKey?: string; addonName?: string; title: string; kind?: string }): TrafficEvent =>
  ({ ...statMeta(job), at: job.at, bytes: job.bytes, items: 1 });
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
await playback.load();

// Výchozí heslo by stejně muselo hned pryč, takže žádné nezakládáme: první start
// skončí na obrazovce, kde si účet založí sám uživatel. Instalace, které na
// admin/admin ještě stojí, o něj přijdou a projdou stejným založením.
if (store.auth()?.isDefault) {
  await store.update((state) => { state.auth = undefined; });
  log("WARN", "The default admin/admin sign-in was removed, create your own account on the next visit");
}
/** Bez uloženého účtu i bez záložních údajů z prostředí nejde dělat vůbec nic. */
const needsSetup = () => !store.auth() && !envCredentials();

const secret = () => store.auth()?.secret ?? "";
const isSecure = (req: express.Request) => req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
const knownUser = (name: string) => name === store.auth()?.username || name === envCredentials()?.username;
const currentSession = (req: express.Request) => {
  // Bez účtu není čím podepisovat, takže žádná známka nemůže platit.
  if (!store.auth()) return undefined;
  const info = readSession(secret(), parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!info || !knownUser(info.username)) return undefined;
  // Odhlášená relace je neplatná i s dosud platným podpisem.
  return store.auth()?.revoked?.[info.sid] ? undefined : info;
};
const currentUser = (req: express.Request) => currentSession(req)?.username;

const ownerOf = (req: express.Request): ResourceOwner => {
  const session = currentSession(req);
  if (!session) throw new ResourceError(401, "AUTH_REQUIRED");
  return { sid: session.sid, expiresAt: session.expiresAt };
};
const sourceOf = (req: express.Request): StreamItem => {
  if (["stream", "url", "headers", "path"].some((key) => key in (req.body ?? {}))) throw new ResourceError(400, "UNSAFE_SOURCE_INPUT");
  return mediaResources.get(String(req.body?.sourceId ?? ""), ownerOf(req).sid, "source").stream;
};
const httpSourceOf = async (req: express.Request): Promise<StreamItem> => {
  const stream = sourceOf(req);
  if (stream.url) return stream;
  const token = store.settings().realDebridToken;
  if (!stream.infoHash || !token) throw new Error("Stáhnout lze pouze přímý HTTP stream.");
  const ready = await resolveIfReady(token, stream.infoHash, stream.fileIdx);
  if (!ready) {
    throw Object.assign(new Error("Torrent ještě není na Real-Debrid. Přidejte ho do fronty tlačítkem Do knihovny."), { status: 409 });
  }
  stream.url = ready.download;
  if (ready.filename) stream.behaviorHints = { ...stream.behaviorHints, filename: ready.filename };
  return stream;
};
const internalMediaRequest = (req: express.Request) =>
  /^(?:\/api)?\/media\/[A-Za-z0-9_-]{43}$/.test(req.path) &&
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") &&
  req.query.token === INTERNAL_TOKEN;
const activeMedia = new Set<{ owner: ResourceOwner; res: express.Response; resourceId?: string }>();
const trackMedia = (owner: ResourceOwner, res: express.Response, resourceId?: string) => {
  const active = { owner, res, resourceId };
  activeMedia.add(active);
  res.once("close", () => activeMedia.delete(active));
};
const libraryTarget = async (relative: string) => {
  const target = resolveInside(DOWNLOAD_DIR, relative);
  if (!target || relative.split(/[\\/]/).some((part) => part.startsWith("."))) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
  const [root, resolved] = await Promise.all([realpath(DOWNLOAD_DIR), realpath(target)]);
  if (!isPathWithin(resolved, root)) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
  return resolved;
};
const safeInspection = (info: Awaited<ReturnType<PlaybackManager["inspect"]>>, stream: StreamItem) => ({
  duration: info?.duration,
  video: info?.video ? { codec: safeSourceText(info.video.codec, stream), width: info.video.width, height: info.video.height } : undefined,
  audioTracks: (info?.audioTracks ?? []).map((track) => ({ ...track, title: safeSourceText(track.title, stream), language: safeSourceText(track.language, stream), codec: safeSourceText(track.codec, stream) })),
  subtitleTracks: (info?.subtitleTracks ?? []).map((track) => ({ ...track, title: safeSourceText(track.title, stream), language: safeSourceText(track.language, stream), codec: safeSourceText(track.codec, stream) })),
});
const stopOwnedPlayback = async (sid?: string) => {
  mediaResources.revoke(sid);
  for (const active of activeMedia) if (!sid || active.owner.sid === sid) active.res.destroy();
  for (const [id, owned] of playbackOwners) if (!sid || owned.owner.sid === sid) await playback.stop(id);
  for (const [id, ticket] of deviceDownloadTickets) if (!sid || ticket.owner.sid === sid) deviceDownloadTickets.delete(id);
};

app.use(express.json({ limit: "256kb" }));

// Každý požadavek dostane krátkou značku. Chyba nahlášená z prohlížeče a její příčina
// na serveru se pak dají spojit, aniž by se v logu hledalo podle času.
declare global { namespace Express { interface Request { id?: string } } }
app.use("/api", (req, res, next) => {
  const id = randomUUID().slice(0, 8);
  req.id = id;
  res.setHeader("x-request-id", id);
  const startedAt = Date.now();
  // Segmenty přehrávání chodí po stovkách, proto jen v ladicím režimu.
  res.on("finish", () => log("DEBUG", "API request", { req: id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - startedAt }));
  next();
});
/** Změří, kolik dat odpověď opravdu odešle, a hlásí to statistikám. Počítá se až
 * u zápisu do odpovědi, takže co si klient objednal a pak přehrávání zavřel,
 * se do součtu nedostane. */
const countBytes = (res: express.Response, meta: TrafficMeta) => {
  const measure = (chunk: unknown) => {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) stats.add(meta, Buffer.byteLength(chunk));
  };
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => express.Response;
  res.write = ((...args: unknown[]) => { measure(args[0]); return write(...args); }) as typeof res.write;
  res.end = ((...args: unknown[]) => { measure(args[0]); return end(...args); }) as typeof res.end;
};

/** Přehrávání z knihovny čte soubor z disku, přehrávání z katalogu jde ven přes proxy. */
const playbackMeta = (stream: StreamItem): TrafficMeta => stream.url?.startsWith("file://")
  ? { source: "library", provider: "knihovna", title: path.basename(stream.url.slice(7)), kind: "other" }
  : statMeta({ source: "catalog", url: stream.url, title: sourceTitle(stream) || providerOf(stream.url), addonKey: stream.addonKey, addonName: stream.addonName });

const asyncRoute = (fn: express.RequestHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

// Bez přihlášení je otevřený jen stav serveru a samotné přihlášení. Zvlášť /api/proxy
// nesmí být veřejné, jinak přes něj kdokoli tahá cizí adresy přes tenhle server.
const OPEN_PATHS = new Set(["/status", "/auth/login", "/auth/me", "/auth/setup"]);
app.use("/api", (req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (internalMediaRequest(req)) return next();
  if (!currentUser(req)) return res.status(401).json({ error: "Nepřihlášeno." });
  next();
});

setInterval(() => {
  for (const active of activeMedia) if (active.owner.expiresAt <= Date.now()) active.res.destroy();
  for (const [id, owned] of playbackOwners) if (owned.owner.expiresAt <= Date.now()) void playback.stop(id);
}, 1000).unref();

app.get("/api/auth/me", (req, res) => {
  if (needsSetup()) return res.json({ setup: true });
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Nepřihlášeno." });
  res.json({ username: user });
});

/** Založení účtu při prvním spuštění. Jde jen do chvíle, než nějaký účet existuje. */
app.post("/api/auth/setup", asyncRoute(async (req, res) => {
  if (!needsSetup()) throw new Error("Přihlášení už je nastavené.");
  const username = String(req.body.username ?? "").trim();
  const password = String(req.body.password ?? "");
  if (username.length < 3) throw new Error("Uživatelské jméno musí mít aspoň 3 znaky.");
  if (password.length < 6) throw new Error("Heslo musí mít aspoň 6 znaků.");
  const passwordHash = await hashPassword(password);
  const nextSecret = randomBytes(32).toString("hex");
  await store.update((state) => { state.auth = { username, passwordHash, secret: nextSecret, isDefault: false, revoked: {} }; });
  res.setHeader("set-cookie", sessionCookie(createSession(nextSecret, username, Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000), true, isSecure(req)));
  log("INFO", "Account created on first run", { username });
  res.status(201).json({ username });
}));
const logins = new LoginThrottle();
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const username = String(req.body.username ?? "");
  const password = String(req.body.password ?? "");
  const remember = Boolean(req.body.remember);
  const from = req.ip ?? "unknown";
  const wait = logins.retryAfterMs(from);
  if (wait > 0) {
    const seconds = Math.ceil(wait / 1000);
    log("WARN", "Sign-in refused after repeated failures", { username, from, waitSeconds: seconds });
    res.setHeader("retry-after", String(seconds));
    return res.status(429).json({ error: `Příliš mnoho neúspěšných pokusů, zkuste to za ${seconds} s.` });
  }
  const stored = store.auth();
  const fromEnv = envCredentials();
  // The hash is always computed, even for a name nobody has: a short circuit here
  // would answer an unknown name faster and hand out the list of real ones.
  const passwordMatches = await verifyPassword(password, stored?.passwordHash ?? DECOY_HASH);
  const bySettings = passwordMatches && Boolean(stored) && secretEquals(username, stored?.username ?? "");
  const byEnv = Boolean(fromEnv) && secretEquals(username, fromEnv?.username ?? "") && secretEquals(password, fromEnv?.password ?? "");
  if (!bySettings && !byEnv) {
    logins.fail(from);
    log("WARN", "Failed sign-in", { username, from });
    return res.status(401).json({ error: "Nesprávné jméno nebo heslo." });
  }
  logins.succeed(from);
  const expiresAt = Date.now() + (remember ? REMEMBER_DAYS : 1) * 24 * 60 * 60 * 1000;
  res.setHeader("set-cookie", sessionCookie(createSession(secret(), username, expiresAt), remember, isSecure(req)));
  log("INFO", "Sign-in", { username, remember, viaEnvCredentials: byEnv && !bySettings });
  res.json({ username });
}));
app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const info = currentSession(req);
  res.setHeader("set-cookie", clearedCookie());
  if (!info) return res.status(204).end();
  if (req.body?.everywhere) {
    // Nové tajemství zneplatní všechny dosud vydané známky naráz.
    const nextSecret = randomBytes(32).toString("hex");
    await store.update((state) => { if (state.auth) state.auth = { ...state.auth, secret: nextSecret, revoked: {} }; });
    log("INFO", "Signed out on all devices", { username: info.username });
  } else {
    await store.update((state) => {
      if (state.auth) state.auth = { ...state.auth, revoked: { ...pruneRevoked(state.auth.revoked), [info.sid]: info.expiresAt } };
    });
    log("INFO", "Sign-out", { username: info.username });
  }
  await stopOwnedPlayback(req.body?.everywhere ? undefined : info.sid);
  res.status(204).end();
}));
app.patch("/api/auth/password", asyncRoute(async (req, res) => {
  const stored = store.auth();
  if (!stored) throw new Error("Účet zatím není založený.");
  const current = String(req.body.currentPassword ?? "");
  if (!await verifyPassword(current, stored.passwordHash)) throw new Error("Stávající heslo nesouhlasí.");
  const nextPassword = String(req.body.newPassword ?? "");
  if (nextPassword.length < 6) throw new Error("Nové heslo musí mít aspoň 6 znaků.");
  const username = String(req.body.username ?? stored.username).trim() || stored.username;
  const passwordHash = await hashPassword(nextPassword);
  // Nové tajemství zneplatní všechny dosud vydané známky, včetně cizích zařízení.
  const nextSecret = randomBytes(32).toString("hex");
  await store.update((state) => { state.auth = { username, passwordHash, secret: nextSecret, isDefault: false, revoked: {} }; });
  res.setHeader("set-cookie", sessionCookie(createSession(nextSecret, username, Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000), true, isSecure(req)));
  await stopOwnedPlayback();
  log("INFO", "Credentials changed", { username });
  res.json({ username });
}));

app.get("/api/status", (_req, res) => res.json({ status: "ok", ...build }));
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
  // Nastavení ověřujeme ještě před zápisem: mutátor mění stav na místě, takže
  // výjimka uprostřed něj by v paměti nechala změny, které se nikdy neuloží.
  // Navíc tím odmítneme nesmyslný požadavek dřív, než kvůli němu sáhneme pro manifest.
  const downloadSettings = req.body.downloadSettings === undefined ? undefined : normalizeDownloadSettings(req.body.downloadSettings);
  const reloaded = url && url !== existing.manifestUrl ? await loadAddon(url, role) : undefined;
  await store.update((state) => {
    const addon = state.addons.find((a) => a.key === req.params.key);
    if (!addon) throw new Error("Doplněk nebyl nalezen.");
    if (typeof req.body.enabled === "boolean") addon.enabled = req.body.enabled;
    if (downloadSettings) addon.downloadSettings = downloadSettings;
    addon.role = role;
    if (reloaded) { addon.manifestUrl = reloaded.manifestUrl; addon.manifest = reloaded.manifest; }
  });
  if (reloaded) log("INFO", "Addon reconfigured", { name: reloaded.manifest.name, role });
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
app.get("/api/streams/:type/:id", asyncRoute(async (req, res) => {
  const owner = ownerOf(req);
  const items = await streams(store.addons(), String(req.params.type), String(req.params.id), req.query.addon ? String(req.query.addon) : undefined);
  if (ownerOf(req).sid !== owner.sid) throw new ResourceError(401, "AUTH_REQUIRED");
  res.setHeader("cache-control", "private, no-store").json(items.map((item) => mediaResources.publicStream(item, owner)));
}));
app.get("/api/subtitles/:type/:id", asyncRoute(async (req, res) => {
  const owner = ownerOf(req);
  const items = await subtitles(store.addons(), String(req.params.type), String(req.params.id));
  res.setHeader("cache-control", "private, no-store").json(items.map((item) => ({
    subtitleId: mediaResources.add({ url: item.url }, owner, "subtitle"),
    lang: safeSourceText(item.lang, { url: item.url }), addonName: safeSourceText(item.addonName, { url: item.url }),
  })));
}));
app.get("/api/subtitle/:subtitleId", asyncRoute(async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  if ("url" in req.query || "headers" in req.query) throw new ResourceError(400, "UNSAFE_SOURCE_INPUT");
  const owner = ownerOf(req);
  const resource = mediaResources.get(String(req.params.subtitleId), owner.sid, "subtitle");
  trackMedia(owner, res, resource.parent);
  const raw = resource.stream.url!;
  const controller = new AbortController();
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });
  const response = await guardedFetch(raw, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Subtitle source unavailable."); }
  let text = await readMediaText(response); if (!text.trimStart().startsWith("WEBVTT")) text = `WEBVTT\n\n${text.replace(/^\ufeff/, "").replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").replace(/^\d+\n(?=\d{2}:\d{2}:\d{2}[.,]\d{3} -->)/gm, "")}`;
  const offset = Number(req.query.offset) || 0; if (offset) text = shiftVtt(text, offset);
  res.type("text/vtt; charset=utf-8").setHeader("cache-control", "private, no-store").send(text);
}));
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/downloads";
const DEVICE_TICKET_TTL = 24 * 60 * 60_000;
type DeviceDownloadTicket = {
  owner: ResourceOwner;
  expiresAt: number;
  filename: string;
  source: { kind: "local"; path: string } | { kind: "remote"; stream: StreamItem; title: string; media?: MediaInfo };
};
const deviceDownloadTickets = new Map<string, DeviceDownloadTicket>();
const pruneDeviceDownloadTickets = () => {
  const now = Date.now();
  for (const [key, ticket] of deviceDownloadTickets) if (ticket.expiresAt <= now) deviceDownloadTickets.delete(key);
  // Bound memory use on long-running servers; expired links can be recreated with another click.
  while (deviceDownloadTickets.size > 500) deviceDownloadTickets.delete(deviceDownloadTickets.keys().next().value!);
};
const metaCache = new Map<string, { value: MetaItem | null; at: number }>();
const cachedMeta = async (type: string, id: string) => {
  const key = `${type}:${id}`;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 60 * 60_000) return hit.value;
  const value = await metadata(store.addons(), type, id).catch(() => null);
  if (metaCache.size > 300) metaCache.clear();
  metaCache.set(key, { value, at: Date.now() });
  return value;
};
// Sken stromu je drahý, drží se chvíli v paměti. Fronta ho po dokončení stahování zneplatní.
let libraryCache: { at: number; entries: Awaited<ReturnType<typeof scanLibrary>> } | undefined;
const libraryEntries = async () => {
  if (libraryCache && Date.now() - libraryCache.at < 30_000) return libraryCache.entries;
  const entries = await scanLibrary(DOWNLOAD_DIR);
  const known = store.libraryMeta();
  // Metadata jen tam, kde známe id z doby stahování. Nic se nehádá z názvu složky.
  await Promise.all(entries.map(async (entry) => {
    const record = known[entry.key];
    if (!record) return;
    const meta = await cachedMeta(record.type, record.id);
    entry.meta = {
      type: record.type, id: record.id, name: meta?.name,
      poster: meta?.poster, background: meta?.background,
      description: typeof meta?.description === "string" ? meta.description : undefined,
      year: meta?.releaseInfo ? String(meta.releaseInfo) : meta?.year ? String(meta.year) : undefined,
    };
  }));
  libraryCache = { at: Date.now(), entries };
  return entries;
};

const ARTWORK_DIR = path.join(process.env.DATA_DIR ?? "/data", "artwork");
const artworkQueue = new ArtworkQueue();
const fileExists = async (file: string) => { try { await access(file); return true; } catch { return false; } };
const dataArtworkFile = (key: string) => path.join(ARTWORK_DIR, `${createHash("sha1").update(key).digest("hex")}.jpg`);

/** Cizí obrázek ve složce má vždy přednost: nic nepřepisujeme ani znovu negenerujeme. */
async function locateArtwork(entry: Awaited<ReturnType<typeof scanLibrary>>[number]) {
  const directory = entryDirectory(entry);
  const folder = path.join(DOWNLOAD_DIR, directory);
  if (directory) {
    const existing = await findArtwork(folder);
    if (existing) return path.join(folder, existing);
  }
  const own = dataArtworkFile(entry.key);
  return await fileExists(own) ? own : undefined;
}

/** Doplní chybějící náhled. Nejdřív plakát z metadat, jinak reprezentativní snímek z videa. */
function scheduleArtwork(entry: Awaited<ReturnType<typeof scanLibrary>>[number]) {
  artworkQueue.run(entry.key, async () => {
    if (await locateArtwork(entry)) return;
    const toMedia = store.settings().artworkLocation === "media";
    const directory = entryDirectory(entry);
    const target = toMedia && directory ? path.join(DOWNLOAD_DIR, directory, POSTER_OUTPUT) : dataArtworkFile(entry.key);
    await mkdir(path.dirname(target), { recursive: true });

    if (entry.meta?.poster && await savePosterFromUrl(path.dirname(target), entry.meta.poster)) {
      if (path.basename(target) !== POSTER_OUTPUT) {
        await rename(path.join(path.dirname(target), POSTER_OUTPUT), target);
      }
      log("INFO", "Poster saved from metadata", { key: entry.key });
      return;
    }
    const source = entry.files[0];
    if (!source) return;
    const info = await playback.inspect({ url: `file://${source.path}` }).catch(() => undefined);
    if (await saveFrame(path.join(DOWNLOAD_DIR, source.path), target, framePosition(info?.duration))) {
      log("INFO", "Thumbnail generated from the video", { key: entry.key });
    }
  });
}

app.get("/api/library", asyncRoute(async (_req, res) => {
  const entries = await libraryEntries();
  const summaries = await Promise.all(entries.map(async (entry) => {
    const art = await locateArtwork(entry);
    if (!art) scheduleArtwork(entry);
    return { ...summarize(entry), poster: art ? `/api/library/thumb?key=${encodeURIComponent(entry.key)}` : undefined };
  }));
  res.json(summaries);
}));
/** Náhled jednoho videa. Vedle videa hledáme jméno podle konvence Jellyfinu. */
async function locateFileArtwork(relative: string) {
  const media = path.join(DOWNLOAD_DIR, path.dirname(relative), episodeArtName(path.basename(relative)));
  if (await fileExists(media)) return media;
  const own = dataArtworkFile(relative);
  return await fileExists(own) ? own : undefined;
}

/** Vazba na titul může být u souboru i u některé nadřazené složky. */
const knownTitle = (relative: string) => {
  const all = store.libraryMeta();
  const parts = relative.split(path.sep);
  let found = all[relative];
  for (let depth = parts.length - 1; !found && depth > 0; depth -= 1) found = all[parts.slice(0, depth).join(path.sep)];
  return found;
};

function scheduleFileArtwork(relative: string) {
  artworkQueue.run(`file:${relative}`, async () => {
    if (await locateFileArtwork(relative)) return;
    const source = resolveInside(DOWNLOAD_DIR, relative);
    if (!source) return;
    const target = store.settings().artworkLocation === "media"
      ? path.join(DOWNLOAD_DIR, path.dirname(relative), episodeArtName(path.basename(relative)))
      : dataArtworkFile(relative);
    await mkdir(path.dirname(target), { recursive: true });

    // Plakát má přednost před snímkem, ať se náhled obnoví správně i po smazání.
    const known = knownTitle(relative);
    if (known) {
      const meta = await cachedMeta(known.type, known.id);
      if (meta?.poster && await savePosterAs(target, meta.poster)) {
        log("INFO", "Poster filled in from metadata", { path: relative });
        return;
      }
    }
    const info = await playback.inspect({ url: `file://${relative}` }).catch(() => undefined);
    await saveFrame(source, target, framePosition(info?.duration));
  });
}

/** Náhled složky: vlastní obrázek, pak plakát z metadat, jinak snímek z prvního videa uvnitř. */
async function locateFolderArtwork(relative: string) {
  const folder = path.join(DOWNLOAD_DIR, relative);
  const existing = await findArtwork(folder);
  if (existing) return path.join(folder, existing);
  const own = dataArtworkFile(`dir:${relative}`);
  return await fileExists(own) ? own : undefined;
}

function scheduleFolderArtwork(relative: string) {
  artworkQueue.run(`dir:${relative}`, async () => {
    if (await locateFolderArtwork(relative)) return;
    const toMedia = store.settings().artworkLocation === "media";
    const target = toMedia ? path.join(DOWNLOAD_DIR, relative, POSTER_OUTPUT) : dataArtworkFile(`dir:${relative}`);
    await mkdir(path.dirname(target), { recursive: true });

    // Vazba může být uložená u přesné složky i u některé nadřazené.
    const all = store.libraryMeta();
    const parts = relative.split(path.sep);
    let known = all[relative];
    for (let depth = parts.length - 1; !known && depth > 0; depth -= 1) known = all[parts.slice(0, depth).join(path.sep)];
    if (known) {
      const meta = await cachedMeta(known.type, known.id);
      if (meta?.poster && await savePosterFromUrl(path.dirname(target), meta.poster)) {
        const written = path.join(path.dirname(target), POSTER_OUTPUT);
        if (written !== target) await rename(written, target);
        return;
      }
    }
    // Snímek bereme z prvního videa uvnitř; když jsou tam jen podsložky, sestoupíme o úroveň.
    const inside = await browseDirectory(DOWNLOAD_DIR, relative, "", 0, 20);
    let first = inside.items.find((item) => item.kind === "file");
    if (!first) {
      const sub = inside.items.find((item) => item.kind === "folder");
      if (sub) first = (await browseDirectory(DOWNLOAD_DIR, sub.path, "", 0, 20)).items.find((item) => item.kind === "file");
    }
    if (!first) return;
    const info = await playback.inspect({ url: `file://${first.path}` }).catch(() => undefined);
    await saveFrame(path.join(DOWNLOAD_DIR, first.path), target, framePosition(info?.duration));
  });
}

/** Náhledy v datech přežijí smazání videa. Po skenu smažeme ty, ke kterým už zdroj neexistuje.
 *  Při ukládání vedle videa tenhle problém nevzniká, obrázek zmizí se složkou. */
let lastArtworkSweep = 0;
async function sweepArtwork() {
  if (Date.now() - lastArtworkSweep < 10 * 60_000) return;
  lastArtworkSweep = Date.now();
  const valid = new Set<string>();
  const remember = (key: string) => {
    valid.add(path.basename(dataArtworkFile(key)));
    const parts = key.split(path.sep);
    for (let depth = 1; depth < parts.length; depth += 1) {
      valid.add(path.basename(dataArtworkFile(`dir:${parts.slice(0, depth).join(path.sep)}`)));
    }
  };
  for (const entry of await libraryEntries()) {
    valid.add(path.basename(dataArtworkFile(entry.key)));
    for (const file of entry.files) remember(file.path);
  }
  // Plakát se ukládá už při zařazení do fronty, kdy zdroj ještě neexistuje.
  // Bez tohohle by ho úklid smazal dřív, než se stahování dokončí.
  for (const job of queue.list()) remember(job.target);

  let removed = 0;
  for (const name of await readdir(ARTWORK_DIR).catch(() => [] as string[])) {
    if (valid.has(name)) continue;
    const file = path.join(ARTWORK_DIR, name);
    // Druhá pojistka: co je čerstvé, se nemaže. Zdroj může teprve vznikat.
    const info = await stat(file).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs < 60 * 60_000) continue;
    await rm(file, { force: true });
    removed += 1;
  }
  if (removed) log("INFO", "Orphaned thumbnails deleted", { removed });
}

// Oblíbené jsou jen příznak u cesty. Nic se nikam nepřesouvá.
const withFavorites = <T extends { path: string }>(items: T[]) => {
  const favorites = new Set(store.favorites());
  return items.map((item) => ({ ...item, favorite: favorites.has(item.path) }));
};

// Oblíbené tituly z katalogu. Klíč je typ a id, protože soubor k nim existovat nemusí.
app.get("/api/watchlist", (_req, res) => {
  const all = store.watchlist();
  res.json(Object.entries(all)
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt)));
});
app.post("/api/watchlist", asyncRoute(async (req, res) => {
  const type = String(req.body.type ?? "movie");
  const id = String(req.body.id ?? "").trim();
  if (!id) throw new Error("Chybí id titulu.");
  const key = `${type}:${id}`;
  const wanted = Boolean(req.body.favorite);
  await store.update((state) => {
    const all = { ...state.watchlist };
    if (wanted) all[key] = { type, id, name: String(req.body.name ?? id), poster: req.body.poster ? String(req.body.poster) : undefined, addedAt: new Date().toISOString() };
    else delete all[key];
    state.watchlist = all;
  });
  res.json({ key, favorite: wanted });
}));

// Rozkoukané: pozice se hlásí průběžně, dokončené se samy zapomenou.
const PROGRESS_DONE = 0.94;
app.get("/api/progress", (_req, res) => {
  const all = store.progress();
  const items = Object.entries(all)
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 40);
  res.json(items);
});
app.get("/api/progress/:key", (req, res) => {
  const found = store.progress()[String(req.params.key)];
  res.json(found ?? null);
});
app.post("/api/progress", asyncRoute(async (req, res) => {
  // Když je sledování vypnuté, pozice se nikam nezapisuje.
  if (!store.settings().trackProgress) return res.status(204).end();
  const key = String(req.body.key ?? "").trim();
  const position = Number(req.body.position) || 0;
  const duration = Number(req.body.duration) || 0;
  if (!key) throw new Error("Chybí klíč titulu.");
  await store.update((state) => {
    const all = { ...state.progress };
    // Skoro dokoukané ani úplný začátek nemá smysl držet.
    if (duration > 0 && (position / duration > PROGRESS_DONE || position < 30)) delete all[key];
    else all[key] = {
      position, duration,
      title: String(req.body.title ?? all[key]?.title ?? "Video"),
      path: req.body.path ? String(req.body.path) : all[key]?.path,
      poster: req.body.poster ? String(req.body.poster) : all[key]?.poster,
      updatedAt: new Date().toISOString(),
    };
    // Seznam nesmí růst donekonečna.
    const keys = Object.keys(all).sort((a, b) => all[b]!.updatedAt.localeCompare(all[a]!.updatedAt));
    state.progress = Object.fromEntries(keys.slice(0, 60).map((item) => [item, all[item]!]));
  });
  res.status(204).end();
}));
app.delete("/api/progress", asyncRoute(async (_req, res) => {
  await store.update((state) => { state.progress = {}; });
  log("INFO", "Watch history cleared");
  res.status(204).end();
}));
app.delete("/api/progress/:key", asyncRoute(async (req, res) => {
  await store.update((state) => { const all = { ...state.progress }; delete all[String(req.params.key)]; state.progress = all; });
  res.status(204).end();
}));

app.post("/api/library/favorite", asyncRoute(async (req, res) => {
  const relative = String(req.body.path ?? "").trim();
  if (!relative || !resolveInside(DOWNLOAD_DIR, relative)) throw new Error("Neplatná cesta.");
  const wanted = Boolean(req.body.favorite);
  await store.update((state) => {
    const current = new Set(state.favorites ?? []);
    if (wanted) current.add(relative); else current.delete(relative);
    state.favorites = [...current];
  });
  res.json({ path: relative, favorite: wanted });
}));

app.get("/api/library/resume", asyncRoute(async (req, res) => {
  const favorites = new Set(store.favorites());
  const query = String(req.query.query ?? "").trim().toLocaleLowerCase();
  const entries = Object.entries(store.progress()).filter(([key, entry]) => key.startsWith("file:") && entry.path);
  const described = await Promise.all(entries.map(async ([, entry]) => {
    const item = await describePath(DOWNLOAD_DIR, entry.path!);
    if (!item || item.kind !== "file") return [];
    return [{ ...item, label: entry.title || item.label, modified: entry.updatedAt,
      progress: { position: entry.position, duration: entry.duration }, favorite: favorites.has(item.path) }];
  }));
  const items = described.flat().filter((item) => (!query || item.label.toLocaleLowerCase().includes(query)) && (req.query.favorites !== "1" || item.favorite));
  const sorts = new Set(["name", "added", "size", "random"]);
  const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "added";
  const ordered = sortFiles(items, sort, req.query.order !== "asc", String(req.query.seed ?? ""));
  const skip = Math.max(0, Number(req.query.skip) || 0);
  const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
  const page = await Promise.all(ordered.slice(skip, skip + limit).map(async (item) => {
    const art = await locateFileArtwork(item.path);
    if (!art) scheduleFileArtwork(item.path);
    return { ...item, poster: art ? `/api/library/thumb?path=${encodeURIComponent(item.path)}` : undefined };
  }));
  res.json({ path: ":resume", items: page, total: ordered.length, pending: page.some((item) => !item.poster) });
}));

app.get("/api/library/favorites", asyncRoute(async (req, res) => {
  const sorts = new Set(["name", "added", "size", "random"]);
  const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "name";
  const described = await Promise.all(store.favorites().map((relative) => describePath(DOWNLOAD_DIR, relative)));
  // Cesty, které mezitím zmizely, se vynechají, ale ze seznamu je nemažeme:
  // disk může být dočasně nedostupný a přijít o oblíbené kvůli tomu by bylo horší.
  const present = described.filter(Boolean) as NonNullable<typeof described[number]>[];
  const mixed = present.map((item) => ({
    ...item, label: item.kind === "folder" ? item.name : item.label,
  }));
  const ordered = sortFiles(mixed, sort, req.query.order === "desc", String(req.query.seed ?? ""));
  const skip = Math.max(0, Number(req.query.skip) || 0);
  const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
  const page = await Promise.all(ordered.slice(skip, skip + limit).map(async (item) => {
    const art = item.kind === "folder" ? await locateFolderArtwork(item.path) : await locateFileArtwork(item.path);
    if (!art) (item.kind === "folder" ? scheduleFolderArtwork : scheduleFileArtwork)(item.path);
    const poster = art ? `/api/library/thumb?${item.kind === "folder" ? "dir" : "path"}=${encodeURIComponent(item.path)}` : undefined;
    return { ...item, favorite: true, poster };
  }));
  res.json({ path: ":favorites", items: page, total: ordered.length, pending: page.some((item) => !item.poster) });
}));

app.get("/api/library/browse", asyncRoute(async (req, res) => {
  const relative = String(req.query.path ?? "");
  const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
  const sorts = new Set(["name", "added", "size", "random"]);
  const sort = sorts.has(String(req.query.sort)) ? String(req.query.sort) as "name" : "name";
  const onlyFavorites = req.query.favorites === "1";
  const favoritePaths = onlyFavorites ? new Set(store.favorites()) : undefined;
  void sweepArtwork();
  const result = await browseDirectory(DOWNLOAD_DIR, relative, String(req.query.query ?? ""),
    Math.max(0, Number(req.query.skip) || 0), limit, sort, req.query.order === "desc", String(req.query.seed ?? ""), favoritePaths);
  // Náhledy chybějících položek se vyrábějí na pozadí; klient si stránku za chvíli vyžádá znovu.
  const items = await Promise.all(result.items.map(async (item) => {
    if (item.kind === "folder") {
      const art = await locateFolderArtwork(item.path);
      if (!art) scheduleFolderArtwork(item.path);
      return { ...item, poster: art ? `/api/library/thumb?dir=${encodeURIComponent(item.path)}` : undefined };
    }
    const art = await locateFileArtwork(item.path);
    if (!art) scheduleFileArtwork(item.path);
    const watched = store.progress()[`file:${item.path}`];
    return {
      ...item,
      poster: art ? `/api/library/thumb?path=${encodeURIComponent(item.path)}` : undefined,
      progress: watched ? { position: watched.position, duration: watched.duration } : undefined,
    };
  }));
  const marked = withFavorites(items);
  res.json({ ...result, items: marked, pending: marked.some((item) => !item.poster) });
}));

// Mazání a přejmenování sahá do skutečných souborů, proto kontrola cesty i kořene.
app.delete("/api/library/item", asyncRoute(async (req, res) => {
  const relative = String(req.query.path ?? "").trim();
  const target = relative && resolveInside(DOWNLOAD_DIR, relative);
  if (!target || target === path.resolve(DOWNLOAD_DIR)) throw new Error("Neplatná cesta.");
  const info = await stat(target).catch(() => undefined);
  if (!info) throw new Error("Soubor nebo složka neexistuje.");
  await rm(target, { recursive: true, force: true });
  await rm(dataArtworkFile(relative), { force: true });
  await rm(dataArtworkFile(`dir:${relative}`), { force: true });
  // Rozkoukané a Můj seznam se vedou pod klíčem katalogu, ne pod cestou, takže by
  // po smazání souboru zůstal titul viset v obou seznamech a nabízel pokračování
  // v něčem, co už na disku není. Vazbu na katalog zná libraryMeta -- odečte se
  // dřív, než ji tenhle úklid smaže.
  const orphans = orphanedCatalogKeys(store.libraryMeta(), relative);
  await store.update((state) => {
    state.favorites = (state.favorites ?? []).filter((item) => !isPathWithin(item, relative));
    state.libraryMeta = Object.fromEntries(Object.entries(state.libraryMeta ?? {}).filter(([key]) => !isPathWithin(key, relative)));
    state.progress = Object.fromEntries(Object.entries(state.progress ?? {}).filter(([key, value]) => {
      if (orphans.has(key)) return false;
      const itemPath = key.startsWith("file:") ? key.slice(5) : value.path;
      return !itemPath || !isPathWithin(itemPath, relative);
    }));
    state.watchlist = Object.fromEntries(Object.entries(state.watchlist ?? {}).filter(([key]) => !orphans.has(key)));
  });
  libraryCache = undefined;
  log("INFO", "Deleted from the library", { path: relative, directory: info.isDirectory(), forgottenTitles: [...orphans] });
  res.status(204).end();
}));

app.post("/api/library/rename", asyncRoute(async (req, res) => {
  const relative = String(req.body.path ?? "").trim();
  const source = relative && resolveInside(DOWNLOAD_DIR, relative);
  if (!source || source === path.resolve(DOWNLOAD_DIR)) throw new Error("Neplatná cesta.");
  const info = await stat(source).catch(() => undefined);
  if (!info) throw new Error("Soubor nebo složka neexistuje.");

  const extension = info.isDirectory() ? "" : path.extname(relative);
  const wanted = safeName(String(req.body.name ?? "").replace(/\.[^.]+$/, ""));
  const nextRelative = path.join(path.dirname(relative), `${wanted}${extension}`);
  const target = resolveInside(DOWNLOAD_DIR, nextRelative);
  if (!target) throw new Error("Neplatné jméno.");
  if (target !== source && await fileExists(target)) throw new Error("Soubor s tímto jménem už existuje.");

  await rename(source, target);
  // Všechny stavové vazby používají relativní cestu; při přesunu musí zůstat konzistentní.
  await store.update((state) => {
    state.favorites = (state.favorites ?? []).map((item) => remapPath(item, relative, nextRelative));
    state.libraryMeta = Object.fromEntries(Object.entries(state.libraryMeta ?? {})
      .map(([key, value]) => [remapPath(key, relative, nextRelative), value]));
    state.progress = Object.fromEntries(Object.entries(state.progress ?? {}).map(([key, value]) => {
      const filePath = key.startsWith("file:") ? key.slice(5) : undefined;
      const nextKey = filePath ? `file:${remapPath(filePath, relative, nextRelative)}` : key;
      const nextPath = value.path ? remapPath(value.path, relative, nextRelative) : value.path;
      return [nextKey, { ...value, path: nextPath }];
    }));
  });
  libraryCache = undefined;
  log("INFO", "Renamed in the library", { from: relative, to: nextRelative });
  res.json({ path: nextRelative });
}));

app.get("/api/library/thumb", asyncRoute(async (req, res) => {
  const filePath = req.query.path ? String(req.query.path) : undefined;
  const dirPath = req.query.dir ? String(req.query.dir) : undefined;
  let art: string | undefined;
  if (filePath) art = await locateFileArtwork(filePath);
  else if (dirPath) art = await locateFolderArtwork(dirPath);
  else {
    const entry = (await libraryEntries()).find((item) => item.key === String(req.query.key ?? ""));
    art = entry && await locateArtwork(entry);
  }
  if (!art) return res.status(404).end();
  res.setHeader("cache-control", "private, no-store");
  res.sendFile(art, (error) => { if (error && !res.headersSent) res.status(404).end(); });
}));
// Ruční přiřazení titulu ke složce, když soubor nepřišel přes frontu.
/** Sváže složku, do které soubor půjde, s titulem z katalogu. Metadata se pak nemusí hádat. */
/** Titul zastupuje jeho složka. U plochého rozvržení žádná není, takže zastupuje sám soubor.
 *  Předsazená složka z nastavení ukládání titulem není, proto se nedá brát první část cesty. */
const titleKey = (target: string, media: MediaInfo | undefined, flat: boolean) => {
  if (flat) return target;
  const directory = path.dirname(target);
  if (directory === ".") return target;
  return media?.kind === "episode" && media.season != null ? path.dirname(directory) : directory;
};

/** Plakát z katalogu se uloží hned při zařazení do fronty, takže je v knihovně dřív než soubor. */
const saveCatalogPoster = (key: string, url?: string) => {
  if (!url || !key || key === ".") return;
  artworkQueue.run(`poster:${key}`, async () => {
    const asFolder = !path.extname(key);
    if (asFolder ? await locateFolderArtwork(key) : await locateFileArtwork(key)) return;
    const toMedia = store.settings().artworkLocation === "media";
    const target = toMedia
      ? (asFolder ? path.join(DOWNLOAD_DIR, key, POSTER_OUTPUT) : path.join(DOWNLOAD_DIR, path.dirname(key), episodeArtName(path.basename(key))))
      : dataArtworkFile(asFolder ? `dir:${key}` : key);
    await mkdir(path.dirname(target), { recursive: true });
    if (await savePosterAs(target, url)) log("INFO", "Poster from the catalog saved", { key });
  });
};

const rememberTitle = async (target: string, media: MediaInfo | undefined, flat: boolean) => {
  if (!media?.id) return;
  const key = titleKey(target, media, flat);
  if (!key || key === ".") return;
  await store.update((state) => {
    state.libraryMeta = { ...state.libraryMeta, [key]: { type: media.metaType ?? (media.kind === "episode" ? "series" : "movie"), id: media.id! } };
  });
};

// Dokončení zneplatní sken okamžitě. U líných úloh zde poprvé známe cílovou cestu,
// takže teprve teď lze uložit vazbu na katalog a plakát.
// Bajty se do statistik zapisují, jak tečou; dokončení už jen doplní, že z toho
// vznikla celá položka. Přerušené stahování tak ve statistikách zůstane -- data
// linkou prošla, i když se soubor nakonec neuložil.
queue.onProgress = (job, bytes) => stats.add(statMeta({ url: job.stream?.url, addonKey: job.stream?.addonKey, addonName: job.stream?.addonName, title: job.title, kind: job.media?.kind }), bytes);
queue.onCompleted = async (job) => {
  libraryCache = undefined;
  await stats.complete(statMeta({ url: job.stream?.url, addonKey: job.stream?.addonKey, addonName: job.stream?.addonName, title: job.title, kind: job.media?.kind }));
  if (!job.source || !job.target || !job.media) return;
  const addon = store.addons().find((item) => item.key === job.stream?.addonKey);
  const settings = addon?.downloadSettings ?? defaultDownloadSettings();
  const targetSettings = job.media.kind === "episode" ? settings.series : settings.movie;
  await rememberTitle(job.target, job.media, targetSettings.layout === "flat");
  saveCatalogPoster(titleKey(job.target, job.media, targetSettings.layout === "flat"), job.media.poster);
};
queue.setDebrid({
  configured: () => Boolean(store.settings().realDebridToken),
  advance: (input) => advanceTorrent(store.settings().realDebridToken, input.infoHash, input.fileIdx, input.torrentId),
});
await queue.load();
await stats.load();
// Historii vezmeme z fronty, aby statistiky nezačínaly prázdné; dokončené úlohy
// se ale dají smazat, takže od téhle chvíle si vedeme vlastní záznam. Doplní se
// jen to, co je starší než vlastní záznam -- novější už v něm je.
await stats.seed(queue.history().map(statEvent));

app.post("/api/library/match", asyncRoute(async (req, res) => {
  const key = String(req.body.key ?? "");
  const id = String(req.body.id ?? "");
  const type = String(req.body.type ?? "movie");
  if (!key) throw new Error("Chybí složka.");
  await store.update((state) => {
    const next = { ...state.libraryMeta };
    if (id) next[key] = { type, id }; else delete next[key];
    state.libraryMeta = next;
  });
  res.json({ key, type, id: id || null });
}));
app.post("/api/library/source", asyncRoute(async (req, res) => {
  const relative = String(req.body.path ?? "");
  const target = relative && await libraryTarget(relative);
  if (!target || !(await stat(target).catch(() => undefined))?.isFile()) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
  res.setHeader("cache-control", "private, no-store").json(mediaResources.publicStream({ url: `file://${relative}`, behaviorHints: { filename: path.basename(relative) } }, ownerOf(req)));
}));

/** Keep the external address out of the download link by exchanging it for a short-lived ticket. */
app.post("/api/device-download", asyncRoute(async (req, res) => {
  pruneDeviceDownloadTickets();
  let ticket: DeviceDownloadTicket;
  const owner = ownerOf(req);
  const stream = await httpSourceOf(req);
  if (stream.url?.startsWith("file://")) {
    const relative = stream.url.slice(7);
    const target = relative && resolveInside(DOWNLOAD_DIR, relative);
    const info = target ? await stat(target).catch(() => undefined) : undefined;
    if (!target || !info?.isFile()) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    ticket = {
      owner, expiresAt: Math.min(owner.expiresAt, Date.now() + DEVICE_TICKET_TTL),
      filename: path.basename(relative),
      source: { kind: "local", path: relative },
    };
  } else {
    if (!stream?.url || stream.url.startsWith("file://")) throw new Error("Stáhnout do zařízení lze pouze přímý HTTP stream.");
    await validateRemoteUrl(stream.url);
    const title = String(req.body.title ?? "video");
    const media = req.body.media as MediaInfo | undefined;
    const addon = store.addons().find((item) => item.key === stream.addonKey);
    const settings = addon?.downloadSettings ?? defaultDownloadSettings();
    const targetSettings = media?.kind === "episode" ? settings.series : settings.movie;
    ticket = {
      owner, expiresAt: Math.min(owner.expiresAt, Date.now() + DEVICE_TICKET_TTL),
      filename: deviceFilename(stream, media, title, targetSettings),
      source: { kind: "remote", stream, title, media },
    };
  }
  const id = randomBytes(24).toString("base64url");
  deviceDownloadTickets.set(id, ticket);
  res.status(201).json({ url: `/api/device-download/${id}`, filename: ticket.filename });
}));

app.get("/api/device-download/:id", asyncRoute(async (req, res) => {
  pruneDeviceDownloadTickets();
  const ticket = deviceDownloadTickets.get(String(req.params.id));
  if (!ticket || ticket.owner.sid !== ownerOf(req).sid) return res.status(404).json({ error: "Odkaz ke stažení vypršel. Spusťte stažení znovu." });

  res.setHeader("cache-control", "private, no-store");
  trackMedia(ticket.owner, res);
  if (ticket.source.kind === "local") {
    const target = await libraryTarget(ticket.source.path);
    if (!target) return res.status(404).json({ error: "Soubor v knihovně nebyl nalezen." });
    countBytes(res, { source: "library", provider: "knihovna", title: ticket.filename, kind: "other" });
    return void res.download(path.basename(target), ticket.filename, { root: path.dirname(target), acceptRanges: true, dotfiles: "deny" }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: "Soubor v knihovně nebyl nalezen." });
    });
  }

  const { stream, title, media } = ticket.source;
  // The client only requests the ticket URL; the server handles debrid headers and ranges from its own IP.
  const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}) };
  if (req.headers.range) headers.range = req.headers.range;
  const controller = new AbortController();
  const headerTimeout = setTimeout(() => controller.abort(), 30_000);
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  let upstream: Response;
  try { upstream = await safeFetch(stream.url!, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: controller.signal }); }
  finally { clearTimeout(headerTimeout); }
  if (!upstream.ok) { await upstream.body?.cancel(); throw new Error("Download source unavailable."); }

  countBytes(res, statMeta({ source: "download", url: stream.url, title, addonKey: stream.addonKey, addonName: stream.addonName, kind: media?.kind }));
  res.status(upstream.status).attachment(ticket.filename).setHeader("cache-control", "private, no-store");
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
  }
  if (!upstream.body) return void res.end();
  const { Readable } = await import("node:stream");
  try { await pipeline(Readable.fromWeb(upstream.body as never), res, { signal: controller.signal }); }
  catch (error) { if (!res.destroyed && !res.writableEnded) throw error; }
}));
app.get("/api/downloads", (_req, res) => res.json(queue.snapshot()));
app.post("/api/downloads", asyncRoute(async (req, res) => {
  const stream = sourceOf(req);
  const media = req.body.media as MediaInfo | undefined;
  const addon = store.addons().find((item) => item.key === stream.addonKey);
  const settings = addon?.downloadSettings ?? defaultDownloadSettings();
  const targetSettings = media?.kind === "episode" ? settings.series : settings.movie;
  const job = await queue.add(String(req.body.title ?? "video"), stream, media, targetSettings);
  await rememberTitle(job.target, media, targetSettings.layout === "flat");
  saveCatalogPoster(titleKey(job.target, media, targetSettings.layout === "flat"), media?.poster);
  res.status(201).json(job);
}));
// Hromadné přidání epizod: úlohy jsou líné, streamy se u doplňků poptají až při stahování.
app.post("/api/downloads/bulk", asyncRoute(async (req, res) => {
  const title = String(req.body.title ?? "").trim() || "Seriál";
  const type = String(req.body.type ?? "series");
  const parent = req.body.media && typeof req.body.media === "object" ? req.body.media as Record<string, unknown> : {};
  const parentId = String(parent.id ?? "").trim() || undefined;
  const poster = String(parent.poster ?? "").trim() || undefined;
  const metaType = String(parent.metaType ?? type).trim() || type;
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
    const media: MediaInfo = { kind: "episode", title, season, episode: number, episodeTitle, id: parentId, metaType, poster };
    const job = await queue.addPending(jobTitle, { type, videoId }, media);
    if (job) added += 1; else skipped += 1;
  }
  log("INFO", "Bulk addition to the queue", { title, added, skipped });
  res.status(201).json({ added, skipped });
}));
app.post("/api/downloads/:id/pause", asyncRoute(async (req, res) => { await queue.pause(String(req.params.id)); res.status(204).end(); }));
app.post("/api/downloads/:id/resume", asyncRoute(async (req, res) => { await queue.resume(String(req.params.id)); res.status(204).end(); }));
app.post("/api/downloads/:id/retry", asyncRoute(async (req, res) => { await queue.retry(String(req.params.id)); res.status(204).end(); }));
app.post("/api/downloads/:id/move", asyncRoute(async (req, res) => { await queue.move(String(req.params.id), Number(req.body.direction) < 0 ? -1 : 1); res.status(204).end(); }));
app.delete("/api/downloads/:id", asyncRoute(async (req, res) => { await queue.remove(String(req.params.id)); res.status(204).end(); }));
app.delete("/api/downloads", asyncRoute(async (_req, res) => { await queue.clearCompleted(); res.status(204).end(); }));
app.get("/api/settings", (_req, res) => res.json(publicSettings(store.settings())));
app.get("/api/stats", (req, res) => res.json(stats.summary(Number(req.query.hours) || 720)));
app.get("/api/logs", asyncRoute(async (req, res) => {
  const tail = Math.max(0, Math.min(5000, Number(req.query.tail) || 0));
  const hours = Math.max(0, Math.min(24 * 365, Number(req.query.hours) || 0));
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const text = await readLog({ tail: tail || undefined, level: parseLevel(req.query.level), hours: hours || undefined, search: search || undefined });
  res.type("text/plain; charset=utf-8");
  // Prohlížení v rozhraní chce text v okně, stažení chce soubor.
  if (req.query.inline !== "1") res.setHeader("content-disposition", "attachment; filename=stremio-offline.log");
  res.send(text);
}));
app.delete("/api/logs", asyncRoute(async (req, res) => {
  await clearLog();
  log("INFO", "Log cleared from the interface", { user: currentUser(req) });
  res.status(204).end();
}));

/** Prohlížeč je jediné místo, kde je vidět, jak přehrávání skutečně dopadlo. Bez tohohle
 * kanálu končí chyby hls.js a video elementu v konzoli, ke které se uživatel nedostane. */
const CLIENT_LOG_PER_MINUTE = 30;
const clientReports = new Map<string, { count: number; resetAt: number }>();
app.post("/api/client-log", (req, res) => {
  const now = Date.now();
  const who = currentUser(req) ?? req.ip ?? "anonymous";
  const bucket = clientReports.get(who);
  if (!bucket || bucket.resetAt <= now) clientReports.set(who, { count: 1, resetAt: now + 60_000 });
  // Zacyklený přehrávač umí hlásit chybu stokrát za vteřinu; přebytek zahodíme potichu.
  else if (bucket.count >= CLIENT_LOG_PER_MINUTE) return void res.status(204).end();
  else bucket.count += 1;
  if (clientReports.size > 200) for (const [key, value] of clientReports) if (value.resetAt <= now) clientReports.delete(key);

  const level = parseLevel(req.body?.level) ?? "WARN";
  const message = String(req.body?.message ?? "").slice(0, 200) || "client report";
  const context = req.body?.context && typeof req.body.context === "object" && !Array.isArray(req.body.context)
    ? req.body.context as Record<string, unknown> : {};
  log(level, `[web] ${message}`, { ...context, req: req.id, user: currentUser(req), ua: String(req.headers["user-agent"] ?? "").slice(0, 160) });
  res.status(204).end();
});

const freeSpace = async (target: string) => {
  try { const info = await statfs(target); return { path: target, freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize }; }
  catch { return { path: target }; }
};
/** Stav serveru pro hledání problémů. Nepatří do /api/status, ten je bez přihlášení. */
app.get("/api/diagnostics", asyncRoute(async (_req, res) => {
  const jobs = queue.list();
  const byStatus: Record<string, number> = {};
  for (const job of jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
  res.json({
    ...build,
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    logLevel: currentLevel(),
    logRetentionDays: Math.max(0, Number(process.env.LOG_RETENTION_DAYS ?? 7) || 0),
    playback: playback.diagnostics(),
    downloads: {
      total: jobs.length, byStatus,
      halt: queue.haltInfo(),
      failed: jobs.filter((job) => job.status === "failed").slice(0, 10).map((job) => ({ id: job.id, title: job.title, error: job.error })),
    },
    addons: store.addons().map((addon) => ({ name: addon.manifest.name, role: addon.role, enabled: addon.enabled })),
    outbound: outbound.diagnostics(),
    storage: [await freeSpace(process.env.DATA_DIR ?? "/data"), await freeSpace(DOWNLOAD_DIR)],
  });
}));

app.get("/api/settings/export", (_req, res) => {
  res.setHeader("content-disposition", `attachment; filename=stremio-offline-settings-${new Date().toISOString().slice(0, 10)}.json`);
  res.json(createSettingsBackup(store.settings(), store.addons()));
});
app.post("/api/settings/import", asyncRoute(async (req, res) => {
  const backup = parseSettingsBackup(req.body);
  // Manifesty se načtou před jediným zápisem. Nefunkční záloha tak nezmění ani část konfigurace.
  const loaded = await Promise.all(backup.addons.map(async (saved, index) => {
    try {
      const addon = await loadAddon(saved.manifestUrl, saved.role);
      addon.enabled = saved.enabled;
      addon.addedAt = saved.addedAt;
      addon.downloadSettings = saved.downloadSettings;
      return addon;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Doplněk č. ${index + 1} se nepodařilo načíst: ${reason}`);
    }
  }));
  const identities = new Set<string>();
  for (const addon of loaded) {
    const identity = `${addon.manifest.id}\n${addon.manifestUrl}`;
    if (identities.has(identity)) throw new Error(`Záloha obsahuje doplněk „${addon.manifest.name}“ vícekrát.`);
    identities.add(identity);
  }
  await store.update((state) => {
    state.settings = backup.settings;
    state.addons = loaded;
    state.defaultsInstalled = true;
  });
  streamCache.clear();
  queue.changed();
  log("INFO", "Settings backup imported", { addons: loaded.length, version: backup.version });
  res.json({ settings: publicSettings(store.settings()), addons: store.addons().map(publicAddon) });
}));
app.patch("/api/settings", asyncRoute(async (req, res) => {
  let realDebridToken: string | undefined;
  if (req.body.realDebridToken !== undefined) {
    realDebridToken = normalizeToken(req.body.realDebridToken);
    if (realDebridToken) await verifyRealDebridToken(realDebridToken);
  }
  await store.update((state) => {
    if (req.body.concurrentDownloads !== undefined) state.settings.concurrentDownloads = Math.max(1, Math.min(8, Number(req.body.concurrentDownloads) || 1));
    if (req.body.parallelPerProvider !== undefined) state.settings.parallelPerProvider = Math.max(1, Math.min(8, Number(req.body.parallelPerProvider) || 1));
    if (req.body.audioLanguage !== undefined) state.settings.audioLanguage = normalizeLanguage(String(req.body.audioLanguage)) ?? "cs";
    if (req.body.subtitleLanguage !== undefined) state.settings.subtitleLanguage = normalizeLanguage(String(req.body.subtitleLanguage)) ?? "cs";
    if (req.body.mergeByName !== undefined) state.settings.mergeByName = Boolean(req.body.mergeByName);
    if (req.body.trackProgress !== undefined) state.settings.trackProgress = Boolean(req.body.trackProgress);
    if (req.body.showResumeRow !== undefined) state.settings.showResumeRow = Boolean(req.body.showResumeRow);
    if (req.body.artworkLocation !== undefined) {
      state.settings.artworkLocation = req.body.artworkLocation === "media" ? "media" : "data";
    }
    if (req.body.streamSort !== undefined) {
      const value = String(req.body.streamSort);
      state.settings.streamSort = STREAM_SORTS.has(value) ? value : "recommended";
    }
    if (req.body.catalogTileSize !== undefined) {
      const value = String(req.body.catalogTileSize);
      state.settings.catalogTileSize = value === "compact" || value === "small" || value === "large" ? value : "medium";
    }
    if (req.body.libraryTileSize !== undefined) {
      const value = String(req.body.libraryTileSize);
      state.settings.libraryTileSize = value === "compact" || value === "small" || value === "large" ? value : "medium";
    }
    if (realDebridToken !== undefined) state.settings.realDebridToken = realDebridToken;
  });
  queue.changed(); res.json(publicSettings(store.settings()));
}));
app.get("/api/languages", (_req, res) => res.json(Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name }))));
app.post("/api/inspect", asyncRoute(async (req, res) => {
  const stream = await httpSourceOf(req);
  const info = await playback.inspect(stream);
  res.setHeader("cache-control", "private, no-store").json(safeInspection(info, stream));
}));
app.post("/api/playback", asyncRoute(async (req, res) => {
  const settings = store.settings();
  const options: PlaybackOptions = { audioLanguage: settings.audioLanguage, subtitleLanguage: settings.subtitleLanguage };
  if (req.body.audioTrack !== undefined) options.audioTrack = Number(req.body.audioTrack);
  if (req.body.subtitleTrack !== undefined) options.subtitleTrack = req.body.subtitleTrack === null ? null : Number(req.body.subtitleTrack);
  if (req.body.time !== undefined) options.startTime = Math.max(0, Number(req.body.time) || 0);
  if (req.body.quality !== undefined) options.quality = req.body.quality === null ? null : Number(req.body.quality);
  const owner = ownerOf(req);
  const prepared = mediaResources.mediaStream(await httpSourceOf(req), owner);
  let started;
  const subtitleIds: Record<string, string> = {};
  try {
    if (req.body.subtitleIds !== undefined && (!Array.isArray(req.body.subtitleIds) || req.body.subtitleIds.length > 100)) throw new ResourceError(400, "INVALID_SUBTITLES");
    for (const id of req.body.subtitleIds ?? []) {
      if (typeof id !== "string") throw new ResourceError(400, "INVALID_SUBTITLES");
      const subtitle = mediaResources.get(id, owner.sid, "subtitle");
      subtitleIds[id] = mediaResources.add(subtitle.stream, owner, "subtitle", prepared.resourceId);
    }
    started = await playback.start(prepared.stream, req.body.capabilities as ClientCapabilities, options);
    if (currentSession(req)?.sid !== owner.sid) {
      await playback.stop(started.id);
      throw new ResourceError(401, "AUTH_REQUIRED");
    }
    playbackOwners.set(started.id, { owner, resourceId: prepared.resourceId });
  } catch (error) { mediaResources.remove(prepared.resourceId); throw error; }
  // Bajty počítá proxy, respektive knihovna; tady se přidává jen samotná položka,
  // aby "kolik toho bylo" nezůstalo jen u stahování.
  void stats.complete(playbackMeta(prepared.stream));
  res.status(201).setHeader("cache-control", "private, no-store").json({ ...started, subtitleIds });
}));
app.use("/api/playback/:id", (req, res, next) => {
  const owned = playbackOwners.get(String(req.params.id));
  if (!owned || owned.owner.sid !== currentSession(req)?.sid) return res.status(404).json({ error: "Playback session unavailable.", code: "RESOURCE_NOT_FOUND" });
  res.setHeader("cache-control", "private, no-store");
  playback.touch(String(req.params.id));
  next();
});
app.post("/api/playback/:id/ping", (_req, res) => res.status(204).end());
app.post("/api/playback/:id/seek", asyncRoute(async (req, res) => res.json(await playback.seek(String(req.params.id), Number(req.body.time) || 0))));
app.post("/api/playback/:id/escalate", asyncRoute(async (req, res) => res.json(await playback.escalate(String(req.params.id), Number(req.body.time) || 0))));
app.post("/api/playback/:id/track", asyncRoute(async (req, res) => res.json(await playback.track(String(req.params.id), {
  audio: req.body.audio === undefined ? undefined : Number(req.body.audio),
  subtitle: req.body.subtitle === undefined ? undefined : (req.body.subtitle === null ? null : Number(req.body.subtitle)),
  quality: req.body.quality === undefined ? undefined : (req.body.quality === null ? null : Number(req.body.quality)),
  time: Number(req.body.time) || 0,
}))));
app.delete("/api/playback/:id", asyncRoute(async (req, res) => { await playback.stop(String(req.params.id)); res.status(204).end(); }));
app.get("/api/playback/:id/sidecar.vtt", asyncRoute(async (req, res) => {
  const file = playback.sidecarFile(String(req.params.id));
  if (!file) return res.status(404).end();
  res.type("text/vtt; charset=utf-8").setHeader("cache-control", "private, no-store").sendFile(path.basename(file), { root: path.dirname(file), dotfiles: "deny" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
}));
app.get("/api/playback/:id/:generation/:file", asyncRoute(async (req, res) => {
  const directory = playback.directory(String(req.params.id), String(req.params.generation));
  // Po restartu převodu si klient ještě chvíli říká o starou generaci; jako 404 je to v pořádku,
  // ale opakované 404 na živou relaci znamenají, že se přehrávání rozpadlo.
  if (!directory) { log("DEBUG", "Segment from an unknown session or generation", { req: req.id, id: req.params.id, generation: req.params.generation, file: req.params.file }); return res.status(404).end(); }
  const file = String(req.params.file);
  // Bez lomítek a teček nemůže jméno utéct z adresáře relace.
  if (!/^[A-Za-z0-9_-]{1,64}\.(m3u8|mp4|m4s|vtt)$/.test(file)) return res.status(400).end();
  if (file === "master.m3u8") {
    // FFmpeg dopisuje řádek s variantou až při ukončení, takže za běhu je master jen hlavička
    // a hls.js na něm skončí s manifestParsingError. Skládáme si ho proto sami.
    // FFmpeg navíc píše HEVC jako hvc1.1.4.L120.B01, jenže prohlížeče uznávají jen tvar B0
    // a stream by odmítly dřív, než ho zkusí; bez atributu si kodeky odvodí z init segmentu.
    const playlist = await readFile(path.join(directory, file), "utf8").catch(() => "");
    if (playlist.includes("#EXT-X-STREAM-INF")) {
      return void res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store")
        .send(playlist.replace(/CODECS="[^"]*"/g, "").replace(/:,+/g, ":").replace(/,{2,}/g, ",").replace(/,\s*$/gm, ""));
    }
    const hasSubtitles = await readFile(path.join(directory, "index-0_vtt.m3u8"), "utf8").then(() => true, () => false);
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
    if (hasSubtitles) lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Titulky",DEFAULT=YES,AUTOSELECT=YES,URI="index-0_vtt.m3u8"');
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=8000000${hasSubtitles ? ',SUBTITLES="subs"' : ""}`, "index-0.m3u8");
    return void res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store").send(`${lines.join("\n")}\n`);
  }
  if (file.endsWith(".m3u8")) res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store");
  else { if (file.endsWith(".vtt")) res.type("text/vtt; charset=utf-8"); res.setHeader("cache-control", "private, no-store"); }
  res.sendFile(file, { root: directory, dotfiles: "deny" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
}));

app.get("/api/media/:resourceId", asyncRoute(async (req, res) => {
  res.setHeader("cache-control", "private, no-store");
  if ("url" in req.query || "headers" in req.query) throw new ResourceError(400, "UNSAFE_SOURCE_INPUT");
  const internal = internalMediaRequest(req);
  const resource = mediaResources.get(String(req.params.resourceId), currentSession(req)?.sid, "media", internal);
  trackMedia(resource.owner, res, resource.parent ?? resource.id);
  const stream = resource.stream;
  const raw = stream.url!;
  const ownedSession = [...playbackOwners].find(([, value]) => value.resourceId === (resource.parent ?? resource.id))?.[0];
  if (ownedSession) {
    playback.touch(ownedSession);
    const heartbeat = setInterval(() => playback.touch(ownedSession), 30_000);
    res.once("close", () => clearInterval(heartbeat));
  }
  if (raw.startsWith("file://")) {
    const relative = raw.slice(7);
    const target = await libraryTarget(relative);
    countBytes(res, { source: "library", provider: "knihovna", title: path.basename(relative), kind: "other" });
    return void res.sendFile(path.basename(target), { root: path.dirname(target), acceptRanges: true, dotfiles: "deny" }, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  }
  await validateRemoteUrl(raw);
  countBytes(res, playbackMeta(stream));
  const headers: Record<string, string> = { ...stream.behaviorHints?.proxyHeaders?.request };
  if (req.headers.range) headers.range = req.headers.range;
  const controller = new AbortController();
  let headerTimedOut = false;
  const headerTimeout = setTimeout(() => { headerTimedOut = true; controller.abort(); }, 30_000);
  // Seek and stop close the previous Range. Without aborting here the old
  // upstream keeps downloading from the debrid host and starves the new one.
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  let upstream: Response;
  try { upstream = await safeFetch(raw, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: controller.signal }); }
  catch (error) {
    if (res.destroyed || res.writableEnded) {
      log("DEBUG", "The client closed the transfer", { req: req.id, url: raw, range: req.headers.range });
      return;
    }
    log("WARN", "The source did not respond", {
      req: req.id, url: raw, range: req.headers.range,
      reason: headerTimedOut ? "no response within 30 s" : (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
  finally { clearTimeout(headerTimeout); }
  if (res.destroyed || res.writableEnded) {
    await upstream.body?.cancel().catch(() => undefined);
    return;
  }
  if (upstream.status >= 400) log("WARN", "The source refused the request", { req: req.id, url: raw, status: upstream.status, range: req.headers.range });
  if (![200, 206].includes(upstream.status)) {
    await upstream.body?.cancel().catch(() => undefined);
    if (upstream.status === 416) {
      const range = upstream.headers.get("content-range");
      if (range && /^bytes \*\/\d+$/.test(range)) res.setHeader("content-range", range);
      return void res.status(416).end();
    }
    return void res.status(502).json({ error: "Media source request failed." });
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("dash+xml") || new URL(upstream.url).pathname.toLowerCase().endsWith(".mpd")) {
    await upstream.body?.cancel();
    throw new Error("DASH playlists are not supported by the media proxy.");
  }
  if (req.method !== "HEAD" && (contentType.includes("mpegurl") || new URL(upstream.url).pathname.toLowerCase().endsWith(".m3u8"))) {
    const finalHeaders = upstreamRequestHeaders(upstream);
    finalHeaders.delete("range");
    finalHeaders.delete("if-range");
    const proxied = (value: string) => {
      const child = new URL(value, upstream.url);
      if (!["http:", "https:"].includes(child.protocol) || child.username || child.password) throw new Error("Unsupported playlist resource.");
      const childHeaders = redirectedHeaders(finalHeaders, new URL(upstream.url), child);
      const id = mediaResources.add({ ...stream, url: child.toString(), behaviorHints: { proxyHeaders: { request: Object.fromEntries(childHeaders) } } }, resource.owner, "media", resource.parent ?? resource.id);
      return `/api/media/${id}${internal ? `?token=${INTERNAL_TOKEN}` : ""}`;
    };
    const playlist = rewritePlaylist(await readMediaText(upstream), proxied, (text) => safeSourceText(text, stream) ?? "");
    if (res.destroyed || res.writableEnded) return;
    res.status(upstream.status).type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store").send(playlist);
    return;
  }
  res.status(upstream.status);
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
  if (!upstream.body) return res.end();
  const { Readable } = await import("node:stream");
  try { await pipeline(Readable.fromWeb(upstream.body as never), res, { signal: controller.signal }); }
  catch (error) {
    await upstream.body?.cancel().catch(() => undefined);
    if (!res.destroyed && !res.writableEnded) {
      log("WARN", "The transfer from the source broke off", { req: req.id, url: raw, range: req.headers.range, reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    log("DEBUG", "The client closed the transfer", { req: req.id, url: raw, range: req.headers.range });
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

app.all(["/api/proxy", "/api/subtitle", "/api/library/file"], (_req, res) => {
  res.status(410).setHeader("cache-control", "private, no-store").json({ error: "This media API has been retired.", code: "UNSAFE_SOURCE_INPUT" });
});

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
app.use(express.static(webRoot, { setHeaders: (res, file) => { if (file.endsWith("index.html")) res.setHeader("Cache-Control", "no-store"); } }));
app.get("/{*path}", (_req, res) => { res.setHeader("Cache-Control", "no-store"); res.sendFile(path.join(webRoot, "index.html")); });
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Výchozích 400 se drží záměrně: rozhraní na jiný kód než 401 nereaguje jinak
  // a měnit to teď by byla změna chování, ne diagnostiky.
  const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
  const message = error instanceof Error ? error.message : String(error);
  log("ERROR", "Request failed", {
    req: req.id, method: req.method, path: req.path, status,
    user: currentUser(req), reason: message,
    stack: error instanceof Error ? error.stack : undefined,
  });
  const mediaRoute = /^(?:\/api)?\/(?:media|playback|inspect|streams|subtitle|subtitles|device-download|library\/source)(?:\/|$)/.test(req.path);
  res.status(error instanceof ResourceError ? error.status : mediaRoute ? 502 : status).json({
    error: error instanceof ResourceError ? error.message : mediaRoute ? "Media source request failed." : message,
    code: error instanceof ResourceError ? error.code : undefined,
  });
});
process.on("unhandledRejection", (reason) => {
  log("ERROR", "Unhandled promise rejection", { reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
});
// A source that closes its connection in an unusual way can trip an assertion deep inside
// Node's own HTTP client (undici), asynchronously, after our download loop's try/catch has
// already returned control -- so nothing in this codebase can catch it directly. Without this
// handler that one bad response takes the whole server down: every active download, every open
// playback session, the web UI itself, until Docker restarts the container. A single flaky
// source shouldn't cost everyone else their evening.
process.on("uncaughtException", (error) => {
  log("ERROR", "Unhandled exception, the server keeps running", { reason: error instanceof Error ? error.stack ?? error.message : String(error) });
});
const port = Number(process.env.PORT ?? 8080);
app.listen(port, "0.0.0.0", () => log("INFO", "Stremio Offline is listening", { port }));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log("INFO", "Shutting down", { signal });
    void flushLog().finally(() => process.exit(0));
  });
}
