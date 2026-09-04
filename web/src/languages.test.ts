import { describe, expect, it } from "vitest";
import { guessLanguages, label } from "./languages";

describe("guessLanguages", () => {
  it("reads flags", () => {
    expect(guessLanguages("Titulky \u{1F1E8}\u{1F1FF}")).toEqual(["cs"]);
    expect(guessLanguages("\u{1F1FA}\u{1F1F8} dub")).toEqual(["en"]);
  });

  it("maps both English flags onto one code", () => {
    expect(guessLanguages("\u{1F1EC}\u{1F1E7} \u{1F1FA}\u{1F1F8}")).toEqual(["en"]);
  });

  it("reads words case-insensitively", () => {
    expect(guessLanguages("Czech audio")).toEqual(["cs"]);
    expect(guessLanguages("SLOVENSKY")).toEqual(["sk"]);
    expect(guessLanguages("Deutsch")).toEqual(["de"]);
  });

  it("collects every language mentioned", () => {
    expect(guessLanguages("CZ/EN dual audio").sort()).toEqual(["cs", "en"]);
  });

  it("does not match a code inside another word", () => {
    expect(guessLanguages("Encoded by someone")).toEqual([]);
    expect(guessLanguages("Skyfall")).toEqual([]);
  });

  it("returns nothing when the text says nothing", () => {
    expect(guessLanguages("1080p WEB-DL x265")).toEqual([]);
  });
});

describe("label", () => {
  it("uses the display label, not the code", () => {
    expect(label("cs")).toBe("CZ");
    expect(label("uk")).toBe("UA");
  });

  it("upper-cases codes it does not know", () => {
    expect(label("xx")).toBe("XX");
  });

  it("marks a missing code", () => {
    expect(label(undefined)).toBe("?");
  });
});
