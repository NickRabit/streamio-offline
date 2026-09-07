import { createHash, randomBytes } from "node:crypto";
import type { PublicStream, StreamItem } from "./types.js";

export interface ResourceOwner { sid: string; expiresAt: number }
export type ResourceScope = "source" | "media" | "subtitle";
interface Resource {
  id: string; owner: ResourceOwner; scope: ResourceScope; stream: StreamItem;
  expiresAt: number; parent?: string; bytes: number; key: string;
}
export class ResourceError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code === "RESOURCE_LIMIT" ? "Too many media resources. Try again later." : "Media resource expired or unavailable. Select the source again.");
  }
}

export function safeSourceText(value: unknown, stream: StreamItem): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.slice(0, 4096);
  const secrets: string[] = [];
  for (const raw of [stream.url, stream.externalUrl, ...(stream.subtitles ?? []).map((item) => item.url)]) {
    if (!raw) continue;
    secrets.push(raw);
    try {
      const url = new URL(raw);
      secrets.push(url.host, ...url.pathname.split("/").filter((part) => part.length >= 8), ...url.searchParams.values());
    } catch { /* Invalid source addresses are never returned. */ }
  }
  for (const value of Object.values(stream.behaviorHints?.proxyHeaders?.request ?? {})) secrets.push(value, ...value.split(/\s+/));
  for (const secret of secrets.filter((item) => item.length >= 3).sort((a, b) => b.length - a.length)) {
    for (const form of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")]) {
      text = text.split(form).join("[redacted]");
    }
  }
  return text.replace(/(?:https?:\/\/|https?%3a%2f%2f|file:\/\/)\S+/gi, "[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function normalizedStream(input: StreamItem): StreamItem {
  const headers = new Headers(input.behaviorHints?.proxyHeaders?.request);
  for (const name of ["host", "connection", "content-length", "transfer-encoding", "x-forwarded-for", "forwarded"]) headers.delete(name);
  return {
    url: typeof input.url === "string" ? input.url : undefined,
    name: safeSourceText(input.name, input), title: safeSourceText(input.title, input),
    description: safeSourceText(input.description, input), addonKey: input.addonKey,
    addonName: safeSourceText(input.addonName, input),
    behaviorHints: { filename: safeSourceText(input.behaviorHints?.filename, input),
      notWebReady: input.behaviorHints?.notWebReady === true,
      videoSize: Number.isFinite(input.behaviorHints?.videoSize) ? input.behaviorHints?.videoSize : undefined,
      proxyHeaders: { request: Object.fromEntries(headers) } },
  };
}

export class MediaResources {
  private entries = new Map<string, Resource>();
  private dedup = new Map<string, string>();
  private expired = new Map<string, { sid: string; scope: ResourceScope }>();
  private creationWindows = new Map<string, { at: number; count: number }>();
  private bindings = new WeakMap<StreamItem, string>();
  private bytes = 0;
  constructor(private now = Date.now, private maxEntries = 2000, private maxBytes = 16 * 1024 * 1024, private creationsPerMinute = 600) {}

  private prune() {
    for (const record of this.entries.values()) if (record.expiresAt <= this.now()) this.remove(record.id, true);
  }

  add(stream: StreamItem, owner: ResourceOwner, scope: ResourceScope, parent?: string, unique = false): string {
    this.prune();
    if (owner.expiresAt <= this.now()) throw new ResourceError(410, "RESOURCE_EXPIRED");
    if (parent) this.get(parent, owner.sid, "media");
    const normalized = normalizedStream(stream);
    const serialized = JSON.stringify(normalized);
    const key = createHash("sha256").update(JSON.stringify([owner.sid, scope, parent, serialized, unique ? randomBytes(16).toString("hex") : ""])).digest("hex");
    const existing = this.dedup.get(key);
    if (existing) return existing;
    if (scope !== "media" && !parent) {
      for (const [sid, window] of this.creationWindows) if (window.at + 60_000 <= this.now()) this.creationWindows.delete(sid);
      if (!this.creationWindows.has(owner.sid) && this.creationWindows.size >= this.maxEntries) throw new ResourceError(429, "RESOURCE_LIMIT");
      const window = this.creationWindows.get(owner.sid) ?? { at: this.now(), count: 0 };
      if (window.count >= this.creationsPerMinute) throw new ResourceError(429, "RESOURCE_LIMIT");
      window.count++;
      this.creationWindows.set(owner.sid, window);
    }
    const bytes = Buffer.byteLength(serialized) + 512;
    if (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) throw new ResourceError(429, "RESOURCE_LIMIT");
    const id = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(owner.expiresAt, scope === "media" || parent ? owner.expiresAt : this.now() + 30 * 60_000);
    this.entries.set(id, { id, owner: { ...owner }, scope, stream: normalized, expiresAt, parent, bytes, key });
    this.dedup.set(key, id);
    this.bytes += bytes;
    return id;
  }

  get(id: string, sid: string | undefined, scope: ResourceScope, internal = false): Resource {
    const record = this.entries.get(id);
    if (!record) {
      const expired = this.expired.get(id);
      const owned = expired && expired.sid === sid && expired.scope === scope;
      throw new ResourceError(owned ? 410 : 404, owned ? "RESOURCE_EXPIRED" : "RESOURCE_NOT_FOUND");
    }
    if ((!internal && record.owner.sid !== sid) || record.scope !== scope) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    if (record.expiresAt <= this.now()) {
      this.remove(id, true);
      throw new ResourceError(410, "RESOURCE_EXPIRED");
    }
    if (record.parent) this.get(record.parent, sid, "media", internal);
    return record;
  }

  remove(id: string, expired = false) {
    const record = this.entries.get(id);
    if (!record) return;
    this.entries.delete(id); this.dedup.delete(record.key); this.bytes -= record.bytes;
    if (expired) {
      this.expired.set(id, { sid: record.owner.sid, scope: record.scope });
      if (this.expired.size > this.maxEntries) this.expired.delete(this.expired.keys().next().value!);
    }
    for (const child of this.entries.values()) if (child.parent === id) this.remove(child.id, expired);
  }

  revoke(sid?: string) {
    for (const record of this.entries.values()) if (!sid || record.owner.sid === sid) this.remove(record.id);
  }

  mediaStream(source: StreamItem, owner: ResourceOwner): { stream: StreamItem; resourceId: string } {
    const resourceId = this.add(source, owner, "media", undefined, true);
    const stream = structuredClone(this.get(resourceId, owner.sid, "media").stream);
    this.bindings.set(stream, resourceId);
    return { stream, resourceId };
  }

  path(stream: StreamItem): string {
    let id = this.bindings.get(stream);
    if (!id) {
      id = this.add(stream, { sid: "internal", expiresAt: this.now() + 30 * 60_000 }, "media");
      this.bindings.set(stream, id);
    }
    return `/api/media/${id}`;
  }

  publicStream(stream: StreamItem, owner: ResourceOwner): PublicStream {
    const kind = stream.url?.startsWith("file://") ? "library" : /^https?:\/\//i.test(stream.url ?? "") ? "remote" : "unsupported";
    const sourceId = this.add(stream, owner, "source");
    const record = this.get(sourceId, owner.sid, "source").stream;
    return {
      sourceId, kind, playable: kind !== "unsupported",
      name: record.name, title: record.title, description: record.description,
      addonKey: record.addonKey, addonName: record.addonName,
      behaviorHints: { filename: record.behaviorHints?.filename, videoSize: record.behaviorHints?.videoSize },
      subtitles: (stream.subtitles ?? []).filter((item) => /^https?:\/\//i.test(item.url)).map((item) => ({
        subtitleId: this.add({ url: item.url }, owner, "subtitle"),
        lang: safeSourceText(item.lang, stream), addonName: safeSourceText(item.addonName, stream),
      })),
    };
  }
}

export const mediaResources = new MediaResources();
