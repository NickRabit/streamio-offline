import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLanguage, normalizeLanguage, pickByLanguage } from "./language.js";

test("různé zápisy téhož jazyka dají stejný kód", () => {
  for (const value of ["cs", "cz", "cze", "ces", "Czech", "čeština", "CS"]) assert.equal(normalizeLanguage(value), "cs");
  for (const value of ["en", "eng", "English"]) assert.equal(normalizeLanguage(value), "en");
});

test("kód s oblastí se zkrátí na jazyk", () => {
  assert.equal(normalizeLanguage("en-US"), "en");
  assert.equal(normalizeLanguage("pt_BR"), "pt");
});

test("neznámý a prázdný vstup nespadne", () => {
  assert.equal(normalizeLanguage(undefined), undefined);
  assert.equal(normalizeLanguage(""), undefined);
  assert.equal(normalizeLanguage("klingon"), undefined);
});

test("jazyk se dá vyčíst z popisku stopy", () => {
  assert.equal(detectLanguage("CZ dabing 5.1"), "cs");
  assert.equal(detectLanguage("English commentary"), "en");
  assert.equal(detectLanguage("Czech AC3"), "cs");
  assert.equal(detectLanguage("SK"), "sk");
});

test("běžná slova se nevydávají za jazyk", () => {
  // "no" je kód norštiny a "it" italštiny, ve větě to jsou ale obyčejná slova.
  assert.equal(detectLanguage("There is no commentary"), undefined);
  assert.equal(detectLanguage("Play it again"), undefined);
  assert.equal(detectLanguage("Director notes"), undefined);
});

test("vybere preferovaný jazyk, jinak angličtinu, jinak výchozí stopu", () => {
  const tracks = [{ language: "de" }, { language: "en" }, { language: "cs" }];
  assert.equal(pickByLanguage(tracks, "cs"), 2);
  assert.equal(pickByLanguage(tracks, "fr"), 1, "spadne na angličtinu");
  assert.equal(pickByLanguage([{ language: "de" }, { language: "pl", default: true }], "fr"), 1);
  assert.equal(pickByLanguage([], "cs"), -1);
});
