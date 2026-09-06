import assert from "node:assert/strict";
import test from "node:test";
import { redirectedHeaders, safeFetch, upstreamRequestHeaders } from "./security.js";

const source = new URL("https://provider.test/media");
const credentials = { Authorization: "Bearer secret", Cookie: "session=secret", "X-Api-Key": "secret", Referer: "https://provider.test/secret", Range: "bytes=10-20" };

test("redirects preserve source headers only within the same origin", () => {
  assert.equal(redirectedHeaders(credentials, source, new URL("/next", source)).get("authorization"), "Bearer secret");
  for (const target of ["https://cdn.test/media", "http://provider.test/media", "https://provider.test:444/media"]) {
    assert.deepEqual(Object.fromEntries(redirectedHeaders(credentials, source, new URL(target))), { range: "bytes=10-20" });
  }
});

test("redirect bodies are canceled and credentials cannot return after an origin change", async (t) => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { delete process.env.ALLOW_PRIVATE_ADDONS; });
  let canceled = 0;
  const calls: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    calls.push(new Headers(init.headers));
    if (calls.length === 3) return new Response("media");
    return new Response(new ReadableStream({ cancel() { canceled++; } }), {
      status: 302, headers: { location: calls.length === 1 ? "https://cdn.test/media" : source.href },
    });
  });
  const response = await safeFetch(source.href, { headers: credentials });
  assert.equal(await response.text(), "media");
  assert.equal(canceled, 2);
  assert.equal(upstreamRequestHeaders(response).get("authorization"), null);
  assert.equal(calls[0].get("authorization"), "Bearer secret");
  assert.equal(calls[1].get("authorization"), null);
  assert.equal(calls[2].get("authorization"), null);
  assert.equal(calls[2].get("range"), "bytes=10-20");
});

test("invalid, missing and excessive redirects cancel their bodies before failing", async (t) => {
  process.env.ALLOW_PRIVATE_ADDONS = "1";
  t.after(() => { delete process.env.ALLOW_PRIVATE_ADDONS; });
  for (const location of [undefined, "file:///secret", "https://cdn.test/loop"]) {
    let canceled = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ cancel() { canceled++; } }), {
      status: 302, headers: location ? { location } : {},
    }));
    await assert.rejects(safeFetch(source.href, {}, 1));
    assert.equal(canceled, location === "https://cdn.test/loop" ? 2 : 1);
    mock.mock.restore();
  }
});
