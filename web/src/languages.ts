/** Addons do not send the language as data; they put it in the stream name as a word or a flag. */
const FLAGS: Record<string, string> = {
  "\u{1F1E8}\u{1F1FF}": "cs", "\u{1F1F8}\u{1F1F0}": "sk", "\u{1F1EC}\u{1F1E7}": "en", "\u{1F1FA}\u{1F1F8}": "en",
  "\u{1F1E9}\u{1F1EA}": "de", "\u{1F1F5}\u{1F1F1}": "pl", "\u{1F1ED}\u{1F1FA}": "hu", "\u{1F1EB}\u{1F1F7}": "fr",
  "\u{1F1EA}\u{1F1F8}": "es", "\u{1F1EE}\u{1F1F9}": "it", "\u{1F1F7}\u{1F1FA}": "ru", "\u{1F1FA}\u{1F1E6}": "uk",
};
const WORDS: Array<[RegExp, string]> = [
  [/\b(czech|cesky|česky|čeština|cestina|cz|cze|ces)\b/i, "cs"],
  [/\b(slovak|slovensky|slovenčina|sk|slk)\b/i, "sk"],
  [/\b(english|eng|en)\b/i, "en"],
  [/\b(german|deutsch|ger|deu)\b/i, "de"],
  [/\b(polish|polski|pol)\b/i, "pl"],
  [/\b(hungarian|magyar|hun)\b/i, "hu"],
];

/** Some addons state the language as a field of the bingeGroup, e.g. "Webshare|CZ,SK|720p|" or
 *  "com.aiostreams.viren070|realdebrid|false|2160p|BluRay|Dubbed|English|Russian". Only a whole
 *  field counts, so a resolution, a release group or the infohash Torrentio falls back to
 *  ("torrentio|aba496ab...411de048be3") never passes for a language. */
const BINGE_CODES: Record<string, string> = {
  cz: "cs", cs: "cs", cze: "cs", ces: "cs", czech: "cs",
  sk: "sk", slk: "sk", slovak: "sk",
  en: "en", eng: "en", english: "en",
  de: "de", ger: "de", deu: "de", german: "de",
  pl: "pl", pol: "pl", polish: "pl",
  hu: "hu", hun: "hu", hungarian: "hu",
};

export function bingeGroupLanguages(bingeGroup?: string): string[] {
  if (!bingeGroup) return [];
  const found = new Set<string>();
  for (const token of bingeGroup.split(/[|,/\s]+/)) {
    const code = BINGE_CODES[token.toLowerCase()];
    if (code) found.add(code);
  }
  return [...found];
}

/** Cinemeta states the language of some titles by its English name ("Czech"), occasionally several. */
const LANGUAGE_NAMES: Record<string, string> = {
  czech: "cs", slovak: "sk", english: "en", german: "de", polish: "pl", hungarian: "hu",
  french: "fr", spanish: "es", italian: "it", russian: "ru", ukrainian: "uk",
};

export function titleLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  for (const part of value.split(/[,/]/)) {
    const code = LANGUAGE_NAMES[part.trim().toLowerCase()];
    if (code) return code;
  }
  return undefined;
}

/** An addon whose bingeGroup has a field it left blank -- Cineshare sends "Webshare||1080p|" when it
 *  found no language -- looked and came up empty, so the title's own language is the best guess left.
 *  A torrent listing names every audio track a release carries and has no such field, so its silence
 *  is not an admission of ignorance and earns no guess. */
export const leavesLanguageBlank = (bingeGroup?: string) =>
  !!bingeGroup && bingeGroup.includes("|") && bingeGroup.split("|").includes("");

export const LANGUAGE_LABEL: Record<string, string> = {
  cs: "CZ", sk: "SK", en: "EN", de: "DE", pl: "PL", hu: "HU", fr: "FR", es: "ES", it: "IT",
  ru: "RU", uk: "UA", ja: "JP", ko: "KR", zh: "CN", pt: "PT", nl: "NL", da: "DK", sv: "SE",
  no: "NO", fi: "FI", ro: "RO", bg: "BG", hr: "HR", sr: "RS", el: "GR", tr: "TR", ar: "AR", he: "IL", hi: "IN",
};
export const label = (code?: string) => code ? LANGUAGE_LABEL[code] ?? code.toUpperCase() : "?";

/** A guess from the text the addon sent. The exact languages come only from probing the chosen stream. */
export function guessLanguages(text: string): string[] {
  const found = new Set<string>();
  for (const [flag, code] of Object.entries(FLAGS)) if (text.includes(flag)) found.add(code);
  for (const [pattern, code] of WORDS) if (pattern.test(text)) found.add(code);
  return [...found];
}

/** Which subtitles an addon should supply when the viewer has not chosen for themselves.
 *  Addon subtitles are always the whole film, never the forced lines alone, so they belong
 *  to a viewer who cannot follow the dialogue: nothing at all while the audio is the language
 *  they asked for, and otherwise their language, with English after it. */
export function pickAddonSubtitle<T extends { lang?: string }>(
  items: T[], preferred: string, spoken?: string, understood?: string,
): T | null {
  if (understood && spoken === understood) return null;
  const speaks = (item: T, language: string) => (item.lang ?? "").toLowerCase().startsWith(language);
  return items.find((item) => speaks(item, preferred)) ?? items.find((item) => speaks(item, "en")) ?? null;
}
