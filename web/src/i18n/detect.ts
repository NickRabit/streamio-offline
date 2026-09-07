/** First run only: no account exists yet, so there is nothing stored to read and the
 *  browser is the best guess we have. Once a language is stored it always wins --
 *  a Czech install opened from an English laptop must stay Czech. */
export function detectLocale<T extends string>(supported: readonly T[], fallback: T): T {
  const tags = (typeof navigator !== "undefined" && navigator.languages?.length ? navigator.languages : [navigator?.language]).filter(Boolean);
  const base = tags.map((tag) => String(tag).toLowerCase().split("-")[0]);
  return base.find((tag): tag is T => (supported as readonly string[]).includes(tag)) ?? fallback;
}
