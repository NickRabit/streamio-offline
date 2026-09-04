// A Stremio addon that answers from memory, so the end-to-end tests never reach
// the internet and always get the same catalog back.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.ADDON_PORT ?? 8098);
const here = path.dirname(fileURLToPath(import.meta.url));
const videoFile = path.join(here, "media", "sample.mp4");

export const MOVIE = {
  id: "tt-e2e-movie",
  type: "movie",
  name: "Zkušební film",
  poster: `http://127.0.0.1:${port}/poster.svg`,
  background: `http://127.0.0.1:${port}/poster.svg`,
  description: "Film, který existuje jen pro testy.",
  releaseInfo: "2024",
  genres: ["Drama"],
};

export const SERIES = {
  id: "tt-e2e-series",
  type: "series",
  name: "Zkušební seriál",
  poster: `http://127.0.0.1:${port}/poster.svg`,
  description: "Seriál, který existuje jen pro testy.",
  releaseInfo: "2023",
  genres: ["Komedie"],
  videos: [
    { id: "tt-e2e-series:1:1", season: 1, episode: 1, title: "První díl", released: "2023-01-01T00:00:00.000Z" },
    { id: "tt-e2e-series:1:2", season: 1, episode: 2, title: "Druhý díl", released: "2023-01-08T00:00:00.000Z" },
    { id: "tt-e2e-series:2:1", season: 2, episode: 1, title: "Nová série", released: "2024-01-01T00:00:00.000Z" },
  ],
};

const MANIFEST = {
  id: "cz.stremio.offline.e2e",
  version: "1.0.0",
  name: "E2E doplněk",
  description: "Zkušební doplněk pro automatické testy.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt-e2e"],
  catalogs: [
    { type: "movie", id: "e2e-movies", name: "Filmy", extra: [{ name: "search" }, { name: "genre", options: ["Drama", "Akce"] }] },
    { type: "series", id: "e2e-series", name: "Seriály", extra: [{ name: "search" }] },
  ],
};

// Two sizes and two languages, so ordering and the language filter have something
// to actually order and filter.
const streamsFor = (id) => [
  { name: "E2E 1080p", title: `Czech \u{1F1E8}\u{1F1FF} 2.4 GB\n${id}`, url: `http://127.0.0.1:${port}/video/${encodeURIComponent(id)}.mp4` },
  { name: "E2E 720p", title: `English \u{1F1EC}\u{1F1E7} 900 MB\n${id}`, url: `http://127.0.0.1:${port}/video/${encodeURIComponent(id)}.mp4` },
];

const POSTER = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <rect width="300" height="450" fill="#1b2330"/><text x="150" y="230" fill="#ff5b38" font-size="28" text-anchor="middle">E2E</text></svg>`;

const json = (res, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};

// The catalog id may be followed by an extras segment, e.g. catalog/movie/id/search=x.json
const route = (pathname) => decodeURIComponent(pathname).replace(/\.json$/, "").split("/").filter(Boolean);

async function serveVideo(req, res) {
  let info;
  try { info = await stat(videoFile); }
  catch { res.writeHead(404).end(); return; }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  const headers = { "content-type": "video/mp4", "accept-ranges": "bytes" };
  if (!range) {
    res.writeHead(200, { ...headers, "content-length": info.size });
    return req.method === "HEAD" ? res.end() : createReadStream(videoFile).pipe(res);
  }
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Number(range[2]) : info.size - 1;
  res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}` });
  return req.method === "HEAD" ? res.end() : createReadStream(videoFile, { start, end }).pipe(res);
}

const server = createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const parts = route(pathname);

  if (pathname === "/manifest.json") return json(res, MANIFEST);
  if (pathname === "/poster.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml" });
    return res.end(POSTER);
  }
  if (parts[0] === "video") return void serveVideo(req, res);
  // Lets a test make an addon call fail without stopping the whole fixture.
  if (pathname === "/boom.json") { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"error":"rozbito"}'); }

  const [resource, type, id, extras] = parts;
  const extra = new URLSearchParams((extras ?? "").replaceAll("&amp;", "&"));
  const search = (extra.get("search") ?? searchParams.get("search") ?? "").toLowerCase();
  const genre = extra.get("genre") ?? searchParams.get("genre") ?? "";

  if (resource === "catalog") {
    const metas = [MOVIE, SERIES]
      .filter((meta) => meta.type === type)
      .filter((meta) => !search || meta.name.toLowerCase().includes(search))
      .filter((meta) => !genre || meta.genres.includes(genre));
    return json(res, { metas });
  }
  if (resource === "meta") {
    const meta = [MOVIE, SERIES].find((item) => item.id === id && item.type === type);
    return meta ? json(res, { meta }) : json(res, {});
  }
  if (resource === "stream") return json(res, { streams: streamsFor(id) });

  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"error":"not found"}');
});

server.listen(port, "127.0.0.1", () => console.log(`e2e addon listening on http://127.0.0.1:${port}/manifest.json`));
