import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLibrary, isVideo, pageFiles, parseEpisode, parseSeason, resolveInside, sortFiles, summarize } from "./library.js";

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

test("víc souborů v jedné složce je jedna položka, ne několik", () => {
  // Přesně případ, kdy se složka objevila dvakrát: jednou za každý soubor.
  const library = buildLibrary([
    file("xxx/prvni.mp4", 10),
    file("xxx/druhy.mp4", 20),
  ]);
  assert.equal(library.length, 1, "složka se nesmí opakovat");
  assert.equal(library[0].title, "xxx");
  assert.equal(library[0].kind, "collection", "složka s víc soubory se prochází, není to film");
  assert.equal(library[0].files.length, 2);
  assert.equal(library[0].size, 30, "velikost je součtem souborů ve složce");
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
  assert.deepEqual(serial.files.map((f) => `${f.season}x${f.episode}`), ["1x2", "1x6", "2x1"]);
  assert.deepEqual(serial.files.map((f) => f.label), ["The Jingle", "The Date", "Nový"]);
});

test("film ve vlastní složce se pojmenuje podle složky", () => {
  const [movie] = buildLibrary([file("The Matrix/The Matrix.mkv")]);
  assert.equal(movie.kind, "movie");
  assert.equal(movie.title, "The Matrix");
  assert.equal(movie.files[0].path, "The Matrix/The Matrix.mkv");
});

test("soubor v kořeni stojí sám za sebe", () => {
  const library = buildLibrary([file("Interstellar.avi"), file("Jiny.mkv")]);
  assert.equal(library.length, 2, "kořenové soubory se neslučují dohromady");
  assert.deepEqual(library.map((e) => e.title).sort(), ["Interstellar", "Jiny"]);
});

test("složka se sezónami je seriál i když má díly volně vedle", () => {
  const [entry] = buildLibrary([file("S/01 serie/01.mkv"), file("S/bonus.mkv")]);
  assert.equal(entry.kind, "series");
  assert.equal(entry.files.length, 2);
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

test("přehled neposílá soubory, jen jejich počet", () => {
  const [entry] = buildLibrary([file("xxx/a.mp4", 5), file("xxx/b.mp4", 7)]);
  const prehled = summarize(entry);
  assert.equal(prehled.fileCount, 2);
  assert.equal(prehled.size, 12);
  assert.ok(!("files" in prehled), "seznam souborů do přehledu nepatří");
});

test("velká složka se vydává po stránkách", () => {
  const many = Array.from({ length: 1000 }, (_, i) => file(`xxx/klip ${String(i).padStart(4, "0")}.mp4`, 1));
  const [entry] = buildLibrary(many);
  assert.equal(entry.files.length, 1000);

  const prvni = pageFiles(entry, "", 0, 100);
  assert.equal(prvni.files.length, 100);
  assert.equal(prvni.total, 1000, "celkový počet se hlásí i při stránkování");

  const dalsi = pageFiles(entry, "", 100, 100);
  assert.notEqual(prvni.files[0].path, dalsi.files[0].path, "druhá stránka nesmí opakovat první");

  const posledni = pageFiles(entry, "", 950, 100);
  assert.equal(posledni.files.length, 50, "za koncem se nic nedomýšlí");
});

test("filtr zúží seznam i celkový počet", () => {
  const many = [
    ...Array.from({ length: 30 }, (_, i) => file(`xxx/klip ${i}.mp4`, 1)),
    file("xxx/jiny nazev.mp4", 1),
  ];
  const [entry] = buildLibrary(many);
  const filtr = pageFiles(entry, "jiny", 0, 100);
  assert.equal(filtr.total, 1);
  assert.equal(filtr.files[0].label, "jiny nazev");
  assert.equal(pageFiles(entry, "KLIP", 0, 100).total, 30, "filtr nerozlišuje velikost písmen");
});

test("druh položky se pozná podle obsahu složky", () => {
  const [film] = buildLibrary([file("Matrix/Matrix.mkv")]);
  assert.equal(film.kind, "movie", "jeden soubor je film");

  const [serial] = buildLibrary([file("S/01 serie/01.mkv"), file("S/01 serie/02.mkv")]);
  assert.equal(serial.kind, "series", "složka se sezónou je seriál");

  const [kolekce] = buildLibrary([file("xxx/a.mp4"), file("xxx/b.mp4"), file("xxx/c.mp4")]);
  assert.equal(kolekce.kind, "collection", "hromada souborů je kolekce k procházení");
});

test("řazení nabízí jméno, přidání, velikost a náhodu", () => {
  const files = [
    { path: "a", label: "Cesta", size: 30, modified: "2026-01-01T00:00:00.000Z" },
    { path: "b", label: "Alej", size: 10, modified: "2026-03-01T00:00:00.000Z" },
    { path: "c", label: "Bota", size: 20, modified: "2026-02-01T00:00:00.000Z" },
  ];
  assert.deepEqual(sortFiles(files, "name", false).map((f) => f.label), ["Alej", "Bota", "Cesta"]);
  assert.deepEqual(sortFiles(files, "name", true).map((f) => f.label), ["Cesta", "Bota", "Alej"]);
  assert.deepEqual(sortFiles(files, "size", true).map((f) => f.size), [30, 20, 10]);
  assert.deepEqual(sortFiles(files, "added", true).map((f) => f.label), ["Alej", "Bota", "Cesta"]);
});

test("náhodné pořadí je pro stejné semínko stabilní, jinak by se stránky opakovaly", () => {
  const files = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}`, label: `f${i}`, size: i, modified: "2026-01-01T00:00:00.000Z" }));
  const prvni = sortFiles(files, "random", false, "seed-1").map((f) => f.path);
  const znovu = sortFiles(files, "random", false, "seed-1").map((f) => f.path);
  const jine = sortFiles(files, "random", false, "seed-2").map((f) => f.path);
  assert.deepEqual(prvni, znovu, "stejné semínko musí dát stejné pořadí");
  assert.notDeepEqual(prvni, jine, "jiné semínko má zamíchat jinak");
  assert.equal(new Set(prvni).size, 40, "nic se neztratí ani nezdvojí");
});

test("řazení platí i na složky, ne jen na soubory", () => {
  const folders = [
    { path: "b", label: "Beta", size: 10, modified: "2026-03-01T00:00:00.000Z" },
    { path: "a", label: "Alfa", size: 30, modified: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(sortFiles(folders, "size", true).map((f) => f.label), ["Alfa", "Beta"]);
  assert.deepEqual(sortFiles(folders, "added", true).map((f) => f.label), ["Beta", "Alfa"]);
});
