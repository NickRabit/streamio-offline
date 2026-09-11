import { randomBytes } from "node:crypto";
import { type MediaResources, type ResourceOwner } from "./media-resources.js";

interface Grant { playbackId: string; owner: ResourceOwner; resourceId: string; token: string; expiresAt: number }

export class AirPlayAccess {
  private grants = new Map<string, Grant>();
  private sessions = new Map<string, string>();
  constructor(private resources: MediaResources, private now = Date.now) {}

  create(playbackId: string, owner: ResourceOwner, resourceId: string) {
    this.remove(playbackId);
    const token = randomBytes(32).toString("base64url");
    this.grants.set(token, { playbackId, owner, resourceId, token, expiresAt: Math.min(owner.expiresAt, this.now() + 12 * 60 * 60_000) });
    this.sessions.set(playbackId, token);
  }

  remove(playbackId: string) {
    const token = this.sessions.get(playbackId);
    if (token) this.grants.delete(token);
    this.sessions.delete(playbackId);
  }

  url(playbackId: string, url: string): string {
    const token = this.sessions.get(playbackId);
    return token ? `${url}${url.includes("?") ? "&" : "?"}airplay=${token}` : url;
  }

  authorize(method: string, pathname: string, token: unknown): Grant | undefined {
    if (!["GET", "HEAD"].includes(method) || typeof token !== "string") return;
    const grant = this.grants.get(token);
    if (!grant) return;
    if (grant.expiresAt <= this.now()) { this.remove(grant.playbackId); return; }
    try {
      this.resources.get(grant.resourceId, grant.owner.sid, "media");
      const media = /^\/api\/media\/([A-Za-z0-9_-]{43})$/.exec(pathname);
      if (media) {
        const resource = this.resources.get(media[1], grant.owner.sid, "media");
        if ((resource.parent ?? resource.id) === grant.resourceId) return grant;
      }
      const segment = /^\/api\/playback\/([A-Za-z0-9-]+)\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\.(?:m3u8|mp4|m4s|vtt)$/.exec(pathname);
      if (segment?.[1] === grant.playbackId) return grant;
    } catch { return; }
  }
}
