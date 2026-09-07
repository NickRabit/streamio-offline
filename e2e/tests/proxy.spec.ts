import { expect, test, type APIRequestContext } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

const control = (request: APIRequestContext, mode: string) => request.get(new URL(`/proxy-control?mode=${mode}`, addonManifest).href);
async function start(request: APIRequestContext) {
  await control(request, "video");
  const sources = await (await request.get("/api/streams/movie/tt-e2e-proxy")).json();
  const response = await request.post("/api/playback", { data: { sourceId: sources[0].sourceId, capabilities: { h264: true, aac: true } } });
  expect(response.status(), await response.text()).toBe(201);
  const playback = await response.json();
  expect(playback.mode).toBe("direct");
  expect(playback.url).toMatch(/^\/api\/media\/[\w-]{43}$/);
  return { ...playback, source: sources[0] };
}

test("opaque proxy suppresses provider errors and sensitive response headers", async ({ request }) => {
  const playback = await start(request);
  for (const status of [200, 302, 401, 403, 500, 416]) {
    await control(request, String(status));
    const response = await request.get(playback.url);
    expect(response.status()).toBe(status === 200 ? 200 : status === 416 ? 416 : 502);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    for (const name of ["set-cookie", "link", "location", "www-authenticate"]) expect(response.headers()[name]).toBeUndefined();
    expect(await response.text()).not.toContain("provider-canary");
    if (status === 416) expect(response.headers()["content-range"]).toBe("bytes */123");
  }
  await request.delete(`/api/playback/${playback.id}`);
});

test("opaque proxy preserves media ranges and HEAD metadata", async ({ request }) => {
  const playback = await start(request);
  const response = await request.get(playback.url, { headers: { range: "bytes=0-31" } });
  expect(response.status()).toBe(206);
  expect((await response.body()).length).toBe(32);
  expect(response.headers()["content-range"]).toMatch(/^bytes 0-31\//);
  const head = await request.head(playback.url, { headers: { range: "bytes=0-31" } });
  expect(head.status()).toBe(206);
  expect(head.headers()["content-length"]).toBe("32");
  expect((await head.body()).length).toBe(0);
  await control(request, "head");
  expect((await request.head(playback.url)).status()).toBe(200);
  await request.delete(`/api/playback/${playback.id}`);
});

test("HLS children are opaque, deduplicated and revoked with their playback", async ({ request }) => {
  const playback = await start(request);
  await control(request, "playlist");
  const response = await request.get(playback.url);
  expect(response.status()).toBe(200);
  const playlist = await response.text();
  expect(playlist).not.toMatch(/canary|token=|headers=|url=/);
  expect(await (await request.get(playback.url)).text()).toBe(playlist);
  const children = [...playlist.matchAll(/\/api\/media\/[\w-]{43}/g)].map(([value]) => value);
  expect(children).toHaveLength(3);
  for (const child of children) expect((await request.get(child)).status()).toBe(200);
  await request.delete(`/api/playback/${playback.id}`);
  for (const child of children) expect((await request.get(child)).status()).toBe(404);
});

test("sources, playback, subtitles and downloads enforce session ownership and reject raw input", async ({ request, playwright }) => {
  const playback = await start(request);
  const serialized = JSON.stringify(playback);
  expect(serialized).not.toMatch(/canary|proxyHeaders|externalUrl/);
  const subtitle = `/api/subtitle/${playback.source.subtitles[0].subtitleId}`;
  expect((await request.get(subtitle)).status()).toBe(200);
  const prepared = await request.post("/api/device-download", { data: { sourceId: playback.source.sourceId } });
  expect(prepared.status()).toBe(201);
  const ticket = await prepared.json();
  expect((await request.get(ticket.url)).status()).toBe(200);
  const foreign = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  await foreign.post("/api/auth/login", { data: { username: "e2e-admin", password: "e2e-password" } });
  for (const url of [playback.url, subtitle, ticket.url]) expect((await foreign.get(url)).status()).toBe(404);
  expect((await foreign.post(`/api/playback/${playback.id}/seek`, { data: { time: 1 } })).status()).toBe(404);
  expect((await foreign.post("/api/inspect", { data: { sourceId: playback.source.sourceId } })).status()).toBe(404);
  expect((await request.post("/api/downloads", { data: { sourceId: playback.url.split("/").pop() } })).status()).toBe(404);
  for (const route of ["/api/inspect", "/api/playback", "/api/downloads", "/api/device-download"]) {
    expect((await request.post(route, { data: { sourceId: playback.source.sourceId, stream: { url: "https://provider-canary.test" } } })).status()).toBe(400);
  }
  for (const route of ["/api/proxy", "/api/proxy/", "/api/subtitle", "/api/library/file"]) expect((await request.get(`${route}?url=https://provider-canary.test`)).status()).toBe(410);
  expect((await request.get("/api/media/forged", { headers: { "x-forwarded-for": "127.0.0.1" } })).status()).toBe(404);
  const ownedByForeign = await start(foreign);
  await foreign.post("/api/auth/logout", { data: {} });
  await foreign.post("/api/auth/login", { data: { username: "e2e-admin", password: "e2e-password" } });
  expect((await foreign.get(ownedByForeign.url)).status()).toBe(404);
  await foreign.dispose();
  await request.delete(`/api/playback/${playback.id}`);
});

test("browser playback renders from the server and never requests provider media", async ({ page, request }) => {
  await control(request, "browser");
  const providerMedia: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.port === new URL(addonManifest).port && (url.pathname.startsWith("/video/") || url.pathname === "/browser-video.webm")) providerMedia.push(url.href);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  const option = await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value");
  await catalog.selectOption(option!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await video.getAttribute("src")).toMatch(/^\/api\/media\/[\w-]{43}$/);
  expect(providerMedia).toEqual([]);
  await control(request, "video");
});

test("converted generations retain playback ownership", async ({ request, playwright }) => {
  const playback = await start(request);
  const changed = await request.post(`/api/playback/${playback.id}/track`, { data: { quality: 480, time: 0 } });
  expect(changed.status(), await changed.text()).toBe(200);
  const converted = await changed.json();
  expect(converted.mode).toBe("transcode");
  expect(converted.url).toMatch(/^\/api\/playback\//);
  const master = await request.get(converted.url);
  expect(master.status()).toBe(200);
  const mediaPath = converted.url.replace("master.m3u8", "index-0.m3u8");
  const playlist = await request.get(mediaPath);
  expect(playlist.status()).toBe(200);
  const text = await playlist.text();
  expect(text).not.toMatch(/query-canary|header-canary|token=/);
  const foreign = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  await foreign.post("/api/auth/login", { data: { username: "e2e-admin", password: "e2e-password" } });
  expect((await foreign.get(mediaPath)).status()).toBe(404);
  await foreign.dispose();
  await request.delete(`/api/playback/${playback.id}`);
  expect((await request.get(mediaPath)).status()).toBe(404);
});

test("local playback and device downloads use opaque resources", async ({ request }) => {
  await expect.poll(async () => (await (await request.get("/api/downloads")).json()).some((job: { status: string }) => job.status === "completed")).toBe(true);
  const jobs = await (await request.get("/api/downloads")).json();
  const job = jobs.find((item: { status: string }) => item.status === "completed");
  const sourceResponse = await request.post("/api/library/source", { data: { path: job.target } });
  expect(sourceResponse.status()).toBe(200);
  const source = await sourceResponse.json();
  expect(source.kind).toBe("library");
  expect(JSON.stringify(source)).not.toContain("file://");
  const response = await request.post("/api/playback", { data: { sourceId: source.sourceId, capabilities: { h264: true, aac: true } } });
  expect(response.status(), await response.text()).toBe(201);
  const playback = await response.json();
  expect(playback.url).toMatch(/^\/api\/media\/[\w-]{43}$/);
  const range = await request.get(playback.url, { headers: { range: "bytes=0-15" } });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(16);
  const prepared = await request.post("/api/device-download", { data: { sourceId: source.sourceId } });
  expect(prepared.status()).toBe(201);
  expect((await request.get((await prepared.json()).url)).status()).toBe(200);
  expect((await request.post("/api/library/source", { data: { path: "../../etc/passwd" } })).status()).toBe(404);
  await request.delete(`/api/playback/${playback.id}`);
});
