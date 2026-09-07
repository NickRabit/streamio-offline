import { useSyncExternalStore } from "react";
import { detectLocale } from "./detect";
import { pluralForm, type PluralForms } from "./plural";
import { en } from "./en";
import { cs } from "./cs";

export const LOCALES = ["en", "cs"] as const;
export type Locale = (typeof LOCALES)[number];
export type Catalog = { [K in keyof typeof en]: (typeof en)[K] extends string ? string : PluralForms };
export type Key = keyof Catalog;
export type Vars = Record<string, string | number>;

/** Always written in the language itself: someone looking for Czech finds "Čeština"
 *  even while the interface is still English. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", cs: "Čeština" };

const CATALOGS: Record<Locale, Catalog> = { en, cs };
const CACHE_KEY = "ui-language";
const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/** The cached value only decides the first paint. The server's answer replaces it as
 *  soon as /api/auth/me lands, and private mode may refuse storage entirely. */
const cached = (): Locale | undefined => {
  try { const value = localStorage.getItem(CACHE_KEY); return isLocale(value) ? value : undefined; }
  catch { return undefined; }
};

let current: Locale = cached() ?? detectLocale(LOCALES, "en");
const listeners = new Set<() => void>();

export const locale = () => current;
export function setLocale(next: Locale) {
  if (!isLocale(next) || next === current) return;
  current = next;
  try { localStorage.setItem(CACHE_KEY, next); } catch { /* storage may be unavailable */ }
  document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

const fill = (text: string, vars?: Vars) =>
  vars ? text.replace(/\{(\w+)\}/g, (match, name) => name in vars ? String(vars[name]) : match) : text;

/** Missing keys render as the key itself: visible in a screenshot, harmless in
 *  production, and the typed catalogue makes them a build error anyway. */
export function t(key: Key, vars?: Vars): string {
  const entry = CATALOGS[current][key] ?? en[key];
  if (entry === undefined) return key;
  const text = typeof entry === "string" ? entry : pluralForm(current, Number(vars?.count ?? 0), entry);
  return fill(text, vars);
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useI18n() {
  const active = useSyncExternalStore(subscribe, locale, locale);
  return { t, locale: active, setLocale };
}

/** Language names come from the browser, so every UI locale gets them for free and
 *  no hand-written table can go stale. */
export function languageName(code: string): string {
  try { return new Intl.DisplayNames([current], { type: "language" }).of(code) ?? code.toUpperCase(); }
  catch { return code.toUpperCase(); }
}

export const localeTag = () => current === "cs" ? "cs-CZ" : "en-GB";
