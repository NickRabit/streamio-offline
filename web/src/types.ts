export type DownloadLayout = "flat" | "structured";
export interface DownloadTargetSettings { subfolder: string; layout: DownloadLayout }
export interface AddonDownloadSettings { movie: DownloadTargetSettings; series: DownloadTargetSettings }
export interface Addon {
  key: string; role: "catalog" | "source" | "both"; enabled: boolean; displayUrl: string;
  configurable: boolean; downloadSettings: AddonDownloadSettings; manifest: { id: string; name: string; version: string; description?: string; logo?: string; resources?: Array<string | { name: string }>; behaviorHints?: { p2p?: boolean } };
}
export interface Catalog { addonKey: string; addonName: string; type: string; id: string; name?: string; extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }> }
export interface Meta {
  id: string; type: string; name: string; poster?: string; background?: string; description?: string; releaseInfo?: string;
  year?: string | number; genres?: string[]; videos?: Video[];
  addonName?: string; sources?: string[]; [key: string]: unknown;
}
export interface SearchResult { items: Meta[]; cursor: string; hasMore: boolean; sources: number }
export interface Video { id?: string; title?: string; name?: string; season?: number; episode?: number; released?: string; overview?: string; thumbnail?: string; [key: string]: unknown }
export interface Subtitle { id?: string; url: string; lang?: string; addonName?: string }
export interface Stream {
  url?: string; externalUrl?: string; infoHash?: string; fileIdx?: number; name?: string; title?: string; description?: string;
  subtitles?: Subtitle[]; addonKey?: string; addonName?: string;
  behaviorHints?: { notWebReady?: boolean; filename?: string; videoSize?: number; proxyHeaders?: { request?: Record<string, string> } };
}
export interface Download { id: string; title: string; status: "queued" | "downloading" | "paused" | "completed" | "failed"; target: string; received: number; total?: number; speed: number; error?: string; order: number; createdAt: string; updatedAt: string; pending?: boolean }

export type PlaybackMode = "direct" | "remux" | "transcode";
export type TileSize = "compact" | "small" | "medium" | "large";
export interface Track { index: number; codec: string; language?: string; title?: string; channels?: number; default?: boolean; forced?: boolean }
export interface Inspection { duration?: number; video?: { codec: string; width?: number; height?: number }; audioTracks: Track[]; subtitleTracks: Track[] }
export interface StatsWindow { bytes: number; count: number }
export interface StatsBucket { key: string; label: string; bytes: number; count: number }
export interface StatsSummary {
  day: StatsWindow; week: StatsWindow; month: StatsWindow; total: StatsWindow;
  days: Array<{ date: string; bytes: number; count: number }>;
  providers: StatsBucket[]; addons: StatsBucket[]; since?: string;
}
export interface Settings { concurrentDownloads: number; parallelPerProvider: number; audioLanguage: string; subtitleLanguage: string; mergeByName: boolean; streamSort: string; artworkLocation: "data" | "media"; trackProgress: boolean; showResumeRow: boolean; catalogTileSize: TileSize; libraryTileSize: TileSize }
export interface Capabilities { h264: boolean; hevc: boolean; hevc10: boolean; vp8: boolean; vp9: boolean; av1: boolean; aac: boolean; mp3: boolean; opus: boolean; vorbis: boolean; ac3: boolean; eac3: boolean; flac: boolean }
export interface PlaybackSession {
  id: string; mode: PlaybackMode; url: string; offset: number; duration?: number; video?: string; audio?: string; hardware: boolean; acceleration: boolean;
  audioTracks: Track[]; subtitleTracks: Track[]; audioTrack: number; subtitleTrack: number | null;
  quality: number | null;
}

export interface Session { username: string; mustChangePassword: boolean }

export interface LibraryFile { path: string; label: string; season: number | null; episode: number | null; size: number; modified: string }
export interface LibrarySummary {
  key: string; kind: "movie" | "series" | "collection"; title: string; fileCount: number; size: number; modified: string;
  poster?: string;
  meta?: { type: string; id: string; name?: string; poster?: string; background?: string; description?: string; year?: string };
}
export interface LibraryPage extends LibrarySummary { files: LibraryFile[]; total: number }
export interface BrowseFolder { path: string; name: string; fileCount: number; size: number; poster?: string }
export interface BrowseFile extends LibraryFile { poster?: string; progress?: { position: number; duration: number } }
export type BrowseItem =
  | ({ kind: "folder"; favorite?: boolean } & BrowseFolder)
  | ({ kind: "file"; favorite?: boolean } & BrowseFile);
export interface BrowseResult { path: string; items: BrowseItem[]; total: number; pending: boolean }
export type LibrarySort = "name" | "added" | "size" | "random";
export interface ProgressEntry { key: string; position: number; duration: number; title: string; path?: string; poster?: string; updatedAt: string }
export interface WatchlistEntry { key: string; type: string; id: string; name: string; poster?: string; addedAt: string }
