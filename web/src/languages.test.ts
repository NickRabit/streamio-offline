import { describe, expect, it } from "vitest";
import { bingeGroupLanguages, guessLanguages, label, leavesLanguageBlank, pickAddonSubtitle, titleLanguage } from "./languages";

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

describe("titleLanguage", () => {
  it("reads the English name Cinemeta sends", () => {
    expect(titleLanguage("Czech")).toBe("cs");
    expect(titleLanguage("German")).toBe("de");
  });

  it("takes the first language it knows from a list", () => {
    expect(titleLanguage("Czech, Slovak")).toBe("cs");
  });

  it("gives up on a name it does not know and on a missing field", () => {
    expect(titleLanguage("Klingon")).toBeUndefined();
    expect(titleLanguage(undefined)).toBeUndefined();
    expect(titleLanguage(42)).toBeUndefined();
  });
});

describe("leavesLanguageBlank", () => {
  it("spots the field Cineshare leaves empty", () => {
    expect(leavesLanguageBlank("Webshare||1080p|")).toBe(true);
    expect(leavesLanguageBlank("Webshare|||")).toBe(true);
  });

  it("does not read a torrent listing as an admission", () => {
    expect(leavesLanguageBlank("torrentio|4k|BluRay|x265|10bit|HDR")).toBe(false);
    expect(leavesLanguageBlank("com.aiostreams.viren070|realdebrid|false|2160p|BluRay|HEVC|WhiteRhino")).toBe(false);
  });

  it("an addon that sends no group at all admits nothing", () => {
    expect(leavesLanguageBlank(undefined)).toBe(false);
    expect(leavesLanguageBlank("")).toBe(false);
    expect(leavesLanguageBlank("Webshare")).toBe(false);
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

describe("pickAddonSubtitle", () => {
  const offered = [{ lang: "en" }, { lang: "cs" }];

  it("leaves the film alone when its audio is the language the viewer asked for", () => {
    expect(pickAddonSubtitle(offered, "cs", "cs", "cs")).toBeNull();
  });

  it("takes the viewer's language when the audio is something else", () => {
    expect(pickAddonSubtitle(offered, "cs", "en", "cs")).toEqual({ lang: "cs" });
  });

  it("falls back to English when the viewer's language is not on offer", () => {
    expect(pickAddonSubtitle([{ lang: "en" }, { lang: "de" }], "cs", "de", "cs")).toEqual({ lang: "en" });
  });

  it("chooses for a film whose audio language nobody could read", () => {
    expect(pickAddonSubtitle(offered, "cs", undefined, "cs")).toEqual({ lang: "cs" });
  });

  it("has nothing to offer when no language fits", () => {
    expect(pickAddonSubtitle([{ lang: "de" }], "cs", "fr", "cs")).toBeNull();
  });
});
