import { describe, expect, it } from "vitest";
import { bingeGroupLanguages, guessLanguages, label } from "./languages";

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

describe("bingeGroupLanguages", () => {
  it("reads the language field Cineshare puts in the group", () => {
    expect(bingeGroupLanguages("Webshare|CZ|1080p|")).toEqual(["cs"]);
    expect(bingeGroupLanguages("Webshare|CZ,SK|720p|BLURAY").sort()).toEqual(["cs", "sk"]);
  });

  it("reads the language names AIOStreams spells out", () => {
    expect(bingeGroupLanguages("com.aiostreams.viren070|realdebrid|false|2160p|BluRay|Dubbed|English|Polish").sort())
      .toEqual(["en", "pl"]);
  });

  it("ignores quality, codec and release group fields", () => {
    expect(bingeGroupLanguages("torrentio|4k|BluRay REMUX|hevc|10bit|DV|HDR")).toEqual([]);
    expect(bingeGroupLanguages("com.aiostreams.viren070|realdebrid|false|2160p|BluRay|HEVC|Atmos|TrueHD|WhiteRhino")).toEqual([]);
  });

  it("matches whole fields only", () => {
    expect(bingeGroupLanguages("provider|Skyfall|Encoded")).toEqual([]);
    // Torrentio falls back to the infohash, whose hex runs read as language codes when split by letter.
    expect(bingeGroupLanguages("torrentio|aba496ab7b4ccd69cd106585771ad411de048be3")).toEqual([]);
  });

  it("returns nothing when the addon sends no group", () => {
    expect(bingeGroupLanguages(undefined)).toEqual([]);
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
