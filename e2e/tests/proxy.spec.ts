import { expect, test } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

const proxy = (path: string) => `/api/proxy?${new URLSearchParams({ url: new URL(path, addonManifest).href })}`;

test("proxy suppresses provider errors and sensitive response headers", async ({ request }) => {
  for (const status of [200, 302, 401, 403, 500, 416]) {
    const response = await request.get(proxy(`/proxy-fixture?status=${status}`));
    expect(response.status()).toBe(status === 200 ? 200 : status === 416 ? 416 : 502);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    for (const name of ["set-cookie", "link", "location", "www-authenticate"]) expect(response.headers()[name]).toBeUndefined();
    expect(await response.text()).not.toContain("provider-canary");
    if (status === 416) expect(response.headers()["content-range"]).toBe("bytes */123");
  }
  for (const route of ["/api/proxy", "/api/proxy/"]) {
    const invalid = await request.get(`${route}?url=${encodeURIComponent("file:///provider-canary")}`);
    expect(invalid.status()).toBe(502);
    expect(await invalid.text()).not.toContain("provider-canary");
  }
});

test("proxy preserves media ranges and HEAD metadata", async ({ request }) => {
  const upstreamHead = await request.head(proxy("/proxy-fixture?head=1"));
  expect(upstreamHead.status()).toBe(200);
  const url = proxy("/video/sample.mp4");
  const response = await request.get(url, { headers: { range: "bytes=0-31" } });
  expect(response.status()).toBe(206);
  expect((await response.body()).length).toBe(32);
  expect(response.headers()["content-range"]).toMatch(/^bytes 0-31\//);
  const head = await request.head(url, { headers: { range: "bytes=0-31" } });
  expect(head.status()).toBe(206);
  expect(head.headers()["content-length"]).toBe("32");
  expect((await head.body()).length).toBe(0);
});


test("HLS child URLs carry credentials only to the same origin", async ({ request }) => {
  const headers = Buffer.from(JSON.stringify({ Authorization: "Bearer header-canary", "X-Api-Key": "key-canary" })).toString("base64url");
  const response = await request.get(`${proxy("/proxy-playlist.m3u8")}&headers=${headers}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const playlist = await response.text();
  const resources = [...playlist.matchAll(/\/api\/proxy\?[^"\s]+/g)].map(([value]) => new URL(value, "http://app.test"));
  expect(resources).toHaveLength(3);
  for (const resource of resources) {
    const upstream = new URL(resource.searchParams.get("url")!);
    if (upstream.hostname === "cdn.test") expect(resource.searchParams.has("headers")).toBe(false);
    else expect(JSON.parse(Buffer.from(resource.searchParams.get("headers")!, "base64url").toString()).authorization).toBe("Bearer header-canary");
  }
});
