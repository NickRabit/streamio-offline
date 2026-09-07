import assert from "node:assert/strict";
import test from "node:test";
import { MediaResources, ResourceError } from "./media-resources.js";

const owner = { sid: "owner-a", expiresAt: 10_000_000 };
const source = { url: "https://provider-canary.test/private-canary?token=query-canary", title: "Movie query-canary", behaviorHints: { proxyHeaders: { request: { Authorization: "Bearer header-canary" } } }, subtitles: [{ url: "https://subtitle-canary.test/sub?secret=sub-canary", lang: "cs" }] };

test("public sources allowlist fields and never contain provider addresses or encoded credentials", () => {
  const registry = new MediaResources(() => 0);
  const publicSource = registry.publicStream({ ...source, unknown: { secret: source.url }, externalUrl: source.url, name: encodeURIComponent(source.url), description: Buffer.from(source.url).toString("base64url") }, owner);
  const serialized = JSON.stringify(publicSource);
  assert.match(publicSource.sourceId, /^[A-Za-z0-9_-]{43}$/);
  for (const secret of [source.url, "query-canary", "provider-canary.test", "header-canary", "subtitle-canary.test"]) {
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")]) assert.ok(!serialized.includes(value), value);
  }
  assert.equal(publicSource.playable, true);
  assert.equal("url" in publicSource, false);
  assert.equal("unknown" in publicSource, false);
  assert.equal("proxyHeaders" in publicSource.behaviorHints, false);
});

test("resources enforce owners, scope, expiry, revocation and deduplication", () => {
  let now = 0;
  const registry = new MediaResources(() => now);
  const id = registry.add(source, owner, "source");
  assert.equal(registry.add(source, owner, "source"), id);
  assert.throws(() => registry.get(id, "owner-b", "source"), { status: 404 });
  assert.throws(() => registry.get(id, owner.sid, "media"), { status: 404 });
  now = 30 * 60_000;
  assert.throws(() => registry.get(id, owner.sid, "source"), { status: 410, code: "RESOURCE_EXPIRED" });
  assert.throws(() => registry.get(id, "owner-b", "source"), { status: 404 });
  const fresh = registry.add(source, owner, "source");
  assert.notEqual(fresh, id);
  registry.revoke(owner.sid);
  assert.throws(() => registry.get(fresh, owner.sid, "source"), { status: 404 });
});

test("playback claims survive selection expiry but not auth expiry or parent removal", () => {
  let now = 0;
  const registry = new MediaResources(() => now);
  const first = registry.mediaStream(source, owner);
  const second = registry.mediaStream(source, owner);
  assert.notEqual(first.resourceId, second.resourceId);
  const child = registry.add({ url: "https://cdn.test/segment" }, owner, "media", first.resourceId);
  now = 31 * 60_000;
  assert.equal(registry.get(child, owner.sid, "media").owner.sid, owner.sid);
  registry.remove(first.resourceId);
  assert.throws(() => registry.get(child, owner.sid, "media"), { status: 404 });
  assert.equal(registry.path(second.stream), `/api/media/${second.resourceId}`);
  now = owner.expiresAt;
  assert.throws(() => registry.get(second.resourceId, owner.sid, "media"), { status: 410 });
});

test("count and byte budgets fail safely without evicting active playback", () => {
  const registry = new MediaResources(() => 0, 1);
  const active = registry.mediaStream(source, owner);
  assert.throws(() => registry.add({ url: "https://other.test" }, owner, "source"), { status: 429 });
  assert.equal(registry.get(active.resourceId, owner.sid, "media").id, active.resourceId);
  assert.throws(() => new MediaResources(() => 0, 10, 10).add(source, owner, "source"), ResourceError);
});

test("claimed subtitles inherit playback lifetime and are revoked with their parent", () => {
  let now = 0;
  const registry = new MediaResources(() => now);
  const selected = registry.add({ url: "https://provider.test/sub" }, owner, "subtitle");
  const media = registry.mediaStream(source, owner);
  const claimed = registry.add(registry.get(selected, owner.sid, "subtitle").stream, owner, "subtitle", media.resourceId);
  now = 31 * 60_000;
  assert.throws(() => registry.get(selected, owner.sid, "subtitle"), { status: 410 });
  assert.equal(registry.get(claimed, owner.sid, "subtitle").parent, media.resourceId);
  registry.remove(media.resourceId);
  assert.throws(() => registry.get(claimed, owner.sid, "subtitle"), { status: 404 });
});

test("selection creation is rate limited but duplicate lookups do not consume capacity", () => {
  let now = 0;
  const registry = new MediaResources(() => now, 10, 100_000, 1);
  const first = registry.add(source, owner, "source");
  assert.equal(registry.add(source, owner, "source"), first);
  assert.throws(() => registry.add({ url: "https://other.test" }, owner, "source"), { status: 429 });
  now = 60_000;
  assert.ok(registry.add({ url: "https://other.test" }, owner, "source"));
});
