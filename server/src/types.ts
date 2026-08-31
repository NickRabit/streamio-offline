export type AddonRole = "catalog" | "source" | "both";

export interface AddonRecord {
  key: string;
  manifestUrl: string;
  role: AddonRole;
  enabled: boolean;
  addedAt: string;
  manifest: StremioManifest;
}

export interface StremioManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  logo?: string;
  resources?: Array<string | { name: string; types?: string[]; idPrefixes?: string[] }>;
  types?: string[];
  idPrefixes?: string[];
  catalogs?: Array<{
    type: string;
    id: string;
    name?: string;
    extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>;
  }>;
  behaviorHints?: { configurable?: boolean; configurationRequired?: boolean; p2p?: boolean };
}

export interface MetaItem {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  year?: string | number;
  genres?: string[];
  videos?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface StreamItem {
  url?: string;
  externalUrl?: string;
  infoHash?: string;
  fileIdx?: number;
  name?: string;
  title?: string;
  description?: string;
  subtitles?: SubtitleItem[];
  behaviorHints?: {
    notWebReady?: boolean;
    filename?: string;
    videoSize?: number;
    proxyHeaders?: { request?: Record<string, string>; response?: Record<string, string> };
  };
  addonKey?: string;
  addonName?: string;
  [key: string]: unknown;
}

export interface SubtitleItem {
  id?: string;
  url: string;
  lang?: string;
  addonName?: string;
  [key: string]: unknown;
}

