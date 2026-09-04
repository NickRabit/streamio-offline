import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceFilename, joinTarget, normalizeDownloadSettings, safeName, safeSubfolder, streamExtension, targetPath } from "./naming.js";

test("film jde do vlastní složky se stejným názvem", () => {
  const { directory, base } = targetPath({ kind: "movie", title: "The Matrix" }, "cokoli", ".mkv");
  assert.equal(joinTarget(directory, base, ".mkv"), "The Matrix/The Matrix.mkv");
});

test("epizoda jde do složky seriálu a série", () => {
  const { directory, base } = targetPath(
    { kind: "episode", title: "Simpsonovi", season: 1, episode: 7, episodeTitle: "Vánoce u Simpsonových" }, "x", ".mp4");
  assert.equal(joinTarget(directory, base, ".mp4"), "Simpsonovi/01 serie/07 - Vánoce u Simpsonových.mp4");
});

test("dvouciferné číslo série i dílu zůstane beze změny", () => {
  const { directory, base } = targetPath({ kind: "episode", title: "Seriál", season: 12, episode: 134, episodeTitle: "Díl" }, "x", ".mkv");
  assert.equal(joinTarget(directory, base, ".mkv"), "Seriál/12 serie/134 - Díl.mkv");
});

test("epizoda bez názvu má aspoň číslo", () => {
  const { directory, base } = targetPath({ kind: "episode", title: "Seriál", season: 2, episode: 3 }, "x", ".mkv");
  assert.equal(joinTarget(directory, base, ".mkv"), "Seriál/02 serie/03.mkv");
});

test("speciály se sezónou nula mají vlastní složku", () => {
  const { directory } = targetPath({ kind: "episode", title: "Seriál", season: 0, episode: 1 }, "x", ".mkv");
  assert.equal(directory, "Seriál/00 serie");
});

test("bez čísla série zůstane epizoda přímo ve složce seriálu", () => {
  const { directory, base } = targetPath({ kind: "episode", title: "Seriál", episode: 5, episodeTitle: "Díl" }, "x", ".mkv");
  assert.equal(joinTarget(directory, base, ".mkv"), "Seriál/05 - Díl.mkv");
});

test("bez údajů o pořadu se použije předaný název", () => {
  const { directory, base } = targetPath(undefined, "Nějaké video", ".avi");
  assert.equal(joinTarget(directory, base, ".avi"), "Nějaké video/Nějaké video.avi");
});

test("kopie dostane pořadové číslo, složka zůstane stejná", () => {
  assert.equal(joinTarget("Film", "Film", ".mkv", 2), "Film/Film (2).mkv");
});

test("název nesmí utéct z cílového adresáře", () => {
  // Podstatné je, že ve výsledku nezůstane oddělovač cesty ani samotné "..".
  for (const attack of ["../../etc/passwd", "..", "..\\..\\windows", "a/../../b", "/etc/passwd"]) {
    const result = safeName(attack);
    assert.ok(!result.includes("/"), `zůstalo lomítko: ${result}`);
    assert.ok(!result.includes("\\"), `zůstalo zpětné lomítko: ${result}`);
    assert.ok(!/(^|\s)\.\.($|\s)/.test(result), `zůstalo ..: ${result}`);
  }
  assert.equal(safeName("../../etc/passwd"), "etc passwd");
  assert.equal(safeName(".."), "video");
  assert.equal(safeName("C:\\Windows\\system32"), "C Windows system32");
});

test("tečky uvnitř názvu zůstanou, koncové zmizí", () => {
  assert.equal(safeName("S.W.A.T. 2017"), "S.W.A.T. 2017");
  assert.equal(safeName("Film."), "Film");
});

test("z názvu zmizí řídicí znaky a zdvojené mezery", () => {
  assert.equal(safeName("Film\u0000\u001f  s   mezerami "), "Film s mezerami");
});

test("prázdný nebo jen tečkový název nespadne", () => {
  assert.equal(safeName("   "), "video");
  assert.equal(safeName("..."), "video");
});

test("příliš dlouhý název se ořízne", () => {
  assert.ok(safeName("a".repeat(400)).length <= 150);
});

test("film lze uložit naplocho do podsložky doplňku", () => {
  const target = targetPath({ kind: "movie", title: "The Matrix" }, "x", ".mkv", { subfolder: "Webshare/Filmy", layout: "flat" });
  assert.equal(joinTarget(target.directory, target.base, ".mkv"), "Webshare/Filmy/The Matrix.mkv");
});

test("seriál lze uložit naplocho bez kolize názvů epizod", () => {
  const target = targetPath({ kind: "episode", title: "Simpsonovi", season: 1, episode: 7, episodeTitle: "Vánoce" }, "x", ".mkv", { subfolder: "Sosac", layout: "flat" });
  assert.equal(joinTarget(target.directory, target.base, ".mkv"), "Sosac/Simpsonovi - S01E07 - Vánoce.mkv");
});

test("strukturované ukládání přidá podsložku před běžnou strukturou", () => {
  const target = targetPath({ kind: "episode", title: "Simpsonovi", season: 2, episode: 3, episodeTitle: "Díl" }, "x", ".mkv", { subfolder: "Streamy/Seriály", layout: "structured" });
  assert.equal(joinTarget(target.directory, target.base, ".mkv"), "Streamy/Seriály/Simpsonovi/02 serie/03 - Díl.mkv");
});

test("výchozí nastavení migruje na základní složku a strukturu", () => {
  assert.deepEqual(normalizeDownloadSettings(undefined), {
    movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" },
  });
});

test("podsložka nesmí uniknout mimo downloads", () => {
  for (const value of ["../tajne", "/etc", "C:\\Windows", "filmy/../../etc"]) assert.throws(() => safeSubfolder(value));
  assert.equal(safeSubfolder("Doplňky/Webshare"), "Doplňky/Webshare");
});

test("device downloads use the same filename as the library", () => {
  const stream = { url: "https://download.example/video?id=secret", behaviorHints: { filename: "release.mkv" } };
  const media = { kind: "episode" as const, title: "Seriál", season: 2, episode: 3, episodeTitle: "Díl" };
  const settings = { subfolder: "Provider/Seriály", layout: "structured" as const };
  assert.equal(streamExtension(stream), ".mkv");
  assert.equal(deviceFilename(stream, media, "fallback", settings), "03 - Díl.mkv");
});

test("URL extensions do not include the debrid query string", () => {
  assert.equal(streamExtension({ url: "https://download.example/Film.mp4?token=velmi-tajny" }), ".mp4");
});
