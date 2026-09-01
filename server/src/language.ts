/** Kontejnery používají ISO 639-1 i 639-2/B i 639-2/T vedle sebe, doplňky navíc píší jazyk slovem. */
const ALIASES: Record<string, string[]> = {
  cs: ["cs", "cz", "cze", "ces", "czech", "cesky", "ceski", "cestina", "čeština", "český", "české"],
  sk: ["sk", "slk", "slo", "slovak", "slovensky", "slovenčina", "slovenský"],
  en: ["en", "eng", "english", "anglicky", "angličtina"],
  de: ["de", "ger", "deu", "german", "deutsch", "němčina"],
  pl: ["pl", "pol", "polish", "polski", "polština"],
  hu: ["hu", "hun", "hungarian", "magyar"],
  fr: ["fr", "fre", "fra", "french", "francais", "français"],
  es: ["es", "spa", "spanish", "espanol", "español"],
  it: ["it", "ita", "italian", "italiano"],
  ru: ["ru", "rus", "russian"],
  uk: ["uk", "ukr", "ukrainian"],
  ja: ["ja", "jpn", "japanese"],
  ko: ["ko", "kor", "korean"],
  zh: ["zh", "chi", "zho", "chinese"],
  pt: ["pt", "por", "portuguese"],
  nl: ["nl", "dut", "nld", "dutch"],
  da: ["da", "dan", "danish"],
  sv: ["sv", "swe", "swedish"],
  no: ["no", "nor", "norwegian"],
  fi: ["fi", "fin", "finnish"],
  ro: ["ro", "rum", "ron", "romanian"],
  bg: ["bg", "bul", "bulgarian"],
  hr: ["hr", "hrv", "croatian"],
  sr: ["sr", "srp", "serbian"],
  el: ["el", "gre", "ell", "greek"],
  tr: ["tr", "tur", "turkish"],
  ar: ["ar", "ara", "arabic"],
  he: ["he", "heb", "hebrew"],
  hi: ["hi", "hin", "hindi"],
};

const LOOKUP = new Map<string, string>();
for (const [code, aliases] of Object.entries(ALIASES)) for (const alias of aliases) LOOKUP.set(alias, code);

export const LANGUAGE_NAMES: Record<string, string> = {
  cs: "Čeština", sk: "Slovenština", en: "Angličtina", de: "Němčina", pl: "Polština", hu: "Maďarština",
  fr: "Francouzština", es: "Španělština", it: "Italština", ru: "Ruština", uk: "Ukrajinština",
  ja: "Japonština", ko: "Korejština", zh: "Čínština", pt: "Portugalština", nl: "Nizozemština",
  da: "Dánština", sv: "Švédština", no: "Norština", fi: "Finština", ro: "Rumunština", bg: "Bulharština",
  hr: "Chorvatština", sr: "Srbština", el: "Řečtina", tr: "Turečtina", ar: "Arabština", he: "Hebrejština", hi: "Hindština",
};

/** Vrátí dvoupísmenný kód, nebo undefined když jazyk nepoznáme. */
export function normalizeLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.toLowerCase().trim().replace(/[_-].*$/, "");
  return LOOKUP.get(cleaned) ?? (/^[a-z]{2}$/.test(cleaned) ? cleaned : undefined);
}

/** Preferovaný jazyk, pak angličtina, pak cokoli. Vrací index do seznamu, nebo -1. */
export function pickByLanguage<T extends { language?: string; default?: boolean }>(tracks: T[], preferred?: string): number {
  if (!tracks.length) return -1;
  for (const wanted of [preferred, "en"].filter(Boolean) as string[]) {
    const found = tracks.findIndex((track) => track.language === wanted);
    if (found >= 0) return found;
  }
  const marked = tracks.findIndex((track) => track.default);
  return marked >= 0 ? marked : 0;
}

/** Záchrana pro soubory bez značky jazyka: leckdy je jazyk aspoň v popisku stopy.
 *  Delší aliasy hledáme bez ohledu na velikost písmen, dvoupísmenné jen jako
 *  samostatné velké slovo — "CZ dabing" je jazyk, "no" ve větě není norština. */
export function detectLanguage(text?: string): string | undefined {
  if (!text) return undefined;
  const haystack = text.toLowerCase();
  for (const [code, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      if (alias.length <= 2) continue;
      if (new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(haystack)) return code;
    }
  }
  const upper = new Set(text.match(/\b[A-Z]{2}\b/g) ?? []);
  for (const token of upper) {
    const code = LOOKUP.get(token.toLowerCase());
    if (code) return code;
  }
  return undefined;
}
