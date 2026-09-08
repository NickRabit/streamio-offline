import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  autoAccept, isExtraName, matchKeyFor, pickSuggestion, scanSkipReason, scoreHit, titleUnits, viewMeta,
} from "./library-match.js";
import { parseMediaPath } from "./library-parse.js";
import type { FoundFile } from "./library.js";
import type { MetaItem } from "./types.js";

const file = (relative: string): FoundFile => ({ relative, size: 1, modified: "2026-01-01T00:00:00.000Z" });
const keys = (files: string[]) => titleUnits(files.map(file)).map((unit) => `${unit.kind}:${unit.key}`).sort();
const meta = (name: string, year: string | number | undefined, type: string, id = name): MetaItem => ({
  id, type, name, ...(year != null ? { releaseInfo: String(year) } : {}),
});

test("movie folder, season series, and an unrelated collection", () => {
  assert.deepEqual(
    keys(["Practical Magic/Practical Magic.mkv"]),
    ["movie:Practical Magic"],
  );
  assert.deepEqual(
    keys(["Father Ted/01 serie/01 - Good Luck, Father Ted.mkv"]),
    ["series:Father Ted"],
  );
  assert.deepEqual(
    keys(["xxx/one.mp4", "xxx/two.mp4", "xxx/I Prefer Anal/I Prefer Anal.mp4"]),
    [],
  );
});

test("same-title copies and a trailer next to one movie are one movie unit", () => {
  assert.deepEqual(
    keys(["Obsession/Obsession.mkv", "Obsession/Obsession (2).mkv"]),
    ["movie:Obsession"],
  );
  assert.deepEqual(
    keys(["Movie/Movie.mkv", "Movie/Movie-trailer.mkv"]),
    ["movie:Movie"],
  );
  assert.equal(isExtraName("Movie-trailer.mkv"), true);
  assert.deepEqual(keys(["Trailers/sample.mkv", "Trailers/bonus.mkv"]), []);
});

test("flat SxxExx files in one folder are a series", () => {
  assert.deepEqual(
    keys(["Show/Show S01E01.mkv", "Show/Show S01E02.mkv"]),
    ["series:Show"],
  );
});

test("loose files at a container sit next to title folders", () => {
  const files = ["Interstellar.avi", "Practical Magic/Practical Magic.mkv"].map(file);
  const units = titleUnits(files);
  assert.deepEqual(units.map((unit) => `${unit.kind}:${unit.key}`).sort(), [
    "movie:Interstellar.avi",
    "movie:Practical Magic",
  ]);
  assert.equal(matchKeyFor("Interstellar.avi", files), "Interstellar.avi");
  assert.equal(matchKeyFor("Practical Magic/Practical Magic.mkv", files), "Practical Magic");
});

test("grouping folders recurse and leftover files are units", () => {
  const files = [
    "Webshare/Movies/Title/file.mkv",
    "Webshare/Movies/leftover.mkv",
  ].map(file);
  const units = titleUnits(files);
  assert.deepEqual(units.map((unit) => `${unit.kind}:${unit.key}`).sort(), [
    "movie:Webshare/Movies/Title",
    "movie:Webshare/Movies/leftover.mkv",
  ]);
  assert.equal(units.some((unit) => unit.key === "Movies" || unit.kind === "series" && unit.key.endsWith("Movies")), false);
  assert.equal(matchKeyFor("Webshare/Movies/Title/file.mkv", files), "Webshare/Movies/Title");
});

test("matchKeyFor walks from an episode to the show and from a collection child to itself", () => {
  const series = ["Father Ted/01 serie/01 - Good Luck, Father Ted.mkv"].map(file);
  assert.equal(matchKeyFor("Father Ted/01 serie/01 - Good Luck, Father Ted.mkv", series), "Father Ted");
  const dump = ["xxx/one.mp4", "xxx/two.mp4", "xxx/I Prefer Anal/I Prefer Anal.mp4"].map(file);
  assert.equal(matchKeyFor("xxx/one.mp4", dump), "xxx/one.mp4");
  assert.equal(matchKeyFor(path.join("xxx", "I Prefer Anal", "I Prefer Anal.mp4"), dump), path.join("xxx", "I Prefer Anal"));
});

test("a unique year-and-title hit auto-accepts; close years do not", () => {
  const parsed = parseMediaPath("Practical Magic");
  const hit = scoreHit(parsed, meta("Practical Magic", 1998, "movie", "tt0120794"), "movie");
  assert.ok(hit.titleSimilarity >= 0.9);
  assert.equal(autoAccept([hit])?.item.id, "tt0120794");

  const obsession = parseMediaPath("Obsession");
  const years = [1949, 1976, 2009].map((year, index) => scoreHit(obsession, meta("Obsession", year, "movie", `tt${index}`), "movie"));
  assert.equal(autoAccept(years), undefined);
  assert.equal(pickSuggestion(years)?.id, years.sort((a, b) => b.score - a.score)[0]!.item.id);
});

test("a 15-point gap at score 85 auto-accepts the series", () => {
  const parsed = parseMediaPath("Father Ted");
  const show = scoreHit(parsed, meta("Father Ted", 1995, "series", "tt0111958"), "series");
  const special = scoreHit(parsed, meta("Father Ted Christmas Special", 1996, "movie", "tt012"), "series");
  assert.ok(show.score >= 85);
  assert.ok(show.score - special.score >= 15);
  assert.equal(autoAccept([show, special])?.item.id, "tt0111958");
});

test("a type mismatch is not auto-accepted", () => {
  const parsed = parseMediaPath("Brave (2012)");
  const wrong = scoreHit(parsed, meta("The Brave One", 2007, "movie", "tt"), "series");
  assert.equal(wrong.autoEligible, false);
  assert.equal(autoAccept([wrong]), undefined);
});

test("Cinemeta series releaseInfo 1995-1998 uses 1995", () => {
  const parsed = parseMediaPath("Father Ted");
  const hit = scoreHit(parsed, { id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995-1998" }, "series");
  assert.equal(hit.yearDelta, undefined);
  parsed.year = 1995;
  const withYear = scoreHit(parsed, { id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995-1998" }, "series");
  assert.equal(withYear.yearDelta, 0);
});

test("legacy libraryMeta rows are download and locked", () => {
  assert.deepEqual(viewMeta({ type: "movie", id: "tt1" }), {
    type: "movie", id: "tt1", source: "download", locked: true,
  });
  assert.equal(scanSkipReason({ type: "movie", id: "tt1" }), "locked");
  assert.equal(scanSkipReason({ type: "movie", id: "tt1", source: "scan", locked: false }), "bound");
  assert.equal(scanSkipReason({ type: "movie", id: "", source: "user", locked: true }), "locked");
  assert.equal(scanSkipReason(undefined), undefined);
});
