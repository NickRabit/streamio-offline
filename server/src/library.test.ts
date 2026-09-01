import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLibrary, isVideo, parseEpisode, parseSeason, resolveInside } from "./library.js";

const file = (relative: string, size = 100, modified = "2026-01-01T00:00:00.000Z") => ({ relative, size, modified });

test("číslo série se pozná z různých zápisů složky", () => {
  assert.equal(parseSeason("01 serie"), 1);
  assert.equal(parseSeason("12 série"), 12);
  assert.equal(parseSeason("Season 2"), 2);
  assert.equal(parseSeason("S03"), 3);
  assert.equal(parseSeason("3"), 3);
  assert.equal(parseSeason("Extra"), null);
});

test("z názvu dílu se oddělí číslo a titulek", () => {
  assert.deepEqual(parseEpisode("07 - Vánoce.mkv"), { episode: 7, title: "Vánoce" });
  assert.deepEqual(parseEpisode("S01E06 The Date.mkv"), { episode: 6, title: "The Date" });
  assert.deepEqual(parseEpisode("03.mkv"), { episode: 3, title: "Epizoda 3" });
  assert.deepEqual(parseEpisode("Bonus.mkv"), { episode: null, title: "Bonus" });
});

test("epizody se poskládají pod seriál a seřadí", () => {
  const library = buildLibrary([
    file("Friday Night Dinner/01 serie/06 - The Date.mkv"),
    file("Friday Night Dinner/01 serie/02 - The Jingle.mkv"),
    file("Friday Night Dinner/02 serie/01 - Nový.mkv"),
  ]);
  assert.equal(library.length, 1);
  const serial = library[0];
  assert.equal(serial.kind, "series");
  assert.equal(serial.title, "Friday Night Dinner");
  assert.deepEqual(serial.episodes?.map((e) => `${e.season}x${e.episode}`), ["1x2", "1x6", "2x1"]);
});

test("film ve vlastní složce se pojmenuje podle složky", () => {
  const [movie] = buildLibrary([file("The Matrix/The Matrix.mkv")]);
  assert.equal(movie.kind, "movie");
  assert.equal(movie.title, "The Matrix");
  assert.equal(movie.path, "The Matrix/The Matrix.mkv");
});

test("film v kořeni se pojmenuje podle souboru bez přípony", () => {
  const [movie] = buildLibrary([file("Interstellar.avi")]);
  assert.equal(movie.title, "Interstellar");
});

test("velikost seriálu je součtem epizod", () => {
  const [serial] = buildLibrary([file("S/01 serie/01.mkv", 10), file("S/01 serie/02.mkv", 15)]);
  assert.equal(serial.size, 25);
});

test("nejnovější přírůstky jsou nahoře", () => {
  const library = buildLibrary([
    file("Stary/Stary.mkv", 1, "2025-01-01T00:00:00.000Z"),
    file("Novy/Novy.mkv", 1, "2026-06-01T00:00:00.000Z"),
  ]);
  assert.deepEqual(library.map((item) => item.title), ["Novy", "Stary"]);
});

test("mimo adresář se stahováním se cesta nedostane", () => {
  const root = "/downloads";
  assert.equal(resolveInside(root, "Film/Film.mkv"), "/downloads/Film/Film.mkv");
  assert.equal(resolveInside(root, "../etc/passwd"), undefined);
  assert.equal(resolveInside(root, "/etc/passwd"), undefined);
  assert.equal(resolveInside(root, "Film/../../secret"), undefined);
  // Adresář, jehož jméno začíná stejně, není totéž co podadresář.
  assert.equal(resolveInside("/downloads", "../downloads-jine/x.mkv"), undefined);
});

test("nevideo soubory se ignorují", () => {
  assert.equal(isVideo("film.mkv"), true);
  assert.equal(isVideo("film.MP4"), true);
  assert.equal(isVideo("titulky.srt"), false);
  assert.equal(isVideo("film.mkv.part"), false);
});
