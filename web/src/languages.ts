/** Doplňky jazyk strukturovaně neposílají, píší ho do názvu streamu slovem nebo vlajkou. */
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

export const LANGUAGE_LABEL: Record<string, string> = {
  cs: "CZ", sk: "SK", en: "EN", de: "DE", pl: "PL", hu: "HU", fr: "FR", es: "ES", it: "IT",
  ru: "RU", uk: "UA", ja: "JP", ko: "KR", zh: "CN", pt: "PT", nl: "NL", da: "DK", sv: "SE",
  no: "NO", fi: "FI", ro: "RO", bg: "BG", hr: "HR", sr: "RS", el: "GR", tr: "TR", ar: "AR", he: "IL", hi: "IN",
};
export const label = (code?: string) => code ? LANGUAGE_LABEL[code] ?? code.toUpperCase() : "?";

/** Odhad z textu, který doplněk poslal. Přesné jazyky zjistí až rozbor vybraného streamu. */
export function guessLanguages(text: string): string[] {
  const found = new Set<string>();
  for (const [flag, code] of Object.entries(FLAGS)) if (text.includes(flag)) found.add(code);
  for (const [pattern, code] of WORDS) if (pattern.test(text)) found.add(code);
  return [...found];
}
