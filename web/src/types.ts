export interface Addon {
  key: string; role: "catalog" | "source" | "both"; enabled: boolean; displayUrl: string;
  configurable: boolean; manifest: { id: string; name: string; version: string; description?: string; logo?: string; behaviorHints?: { p2p?: boolean } };
}
export interface Catalog { addonKey: string; addonName: string; type: string; id: string; name?: string; extra?: Array<{ name: string; isRequired?: boolean }> }
export interface Meta {
  id: string; type: string; name: string; poster?: string; background?: string; description?: string; releaseInfo?: string;
  year?: string | number; genres?: string[]; videos?: Video[]; [key: string]: unknown;
}
export interface Video { id?: string; title?: string; name?: string; season?: number; episode?: number; released?: string; overview?: string; thumbnail?: string; [key: string]: unknown }
export interface Subtitle { id?: string; url: string; lang?: string; addonName?: string }
export interface Stream {
  url?: string; externalUrl?: string; infoHash?: string; fileIdx?: number; name?: string; title?: string; description?: string;
  subtitles?: Subtitle[]; addonKey?: string; addonName?: string;
  behaviorHints?: { notWebReady?: boolean; filename?: string; videoSize?: number; proxyHeaders?: { request?: Record<string, string> } };
}
export interface Download { id: string; title: string; status: string; target: string; received: number; total?: number; speed: number; error?: string }

