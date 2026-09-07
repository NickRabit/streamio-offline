import { describe, expect, it } from "vitest";
import { detectLocale } from "./detect";
import { pluralForm } from "./plural";
import { en } from "./en";
import { cs } from "./cs";

describe("detectLocale", () => {
  const withLanguages = (languages: string[] | undefined, run: () => void) => {
    const original = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { value: languages, configurable: true });
    try { run(); }
    finally { if (original) Object.defineProperty(navigator, "languages", original); }
  };

  it("takes the first supported language, region tag and all", () => {
    withLanguages(["cs-CZ", "en-US"], () => expect(detectLocale(["en", "cs"], "en")).toBe("cs"));
  });

  it("skips languages we do not ship", () => {
    withLanguages(["de-DE", "sk", "cs"], () => expect(detectLocale(["en", "cs"], "en")).toBe("cs"));
  });

  it("falls back when nothing matches", () => {
    withLanguages(["de-DE", "fr"], () => expect(detectLocale(["en", "cs"], "en")).toBe("en"));
  });

  it("survives a browser that exposes no language list", () => {
    withLanguages([], () => expect(detectLocale(["en", "cs"], "en")).toBe("en"));
  });
});

describe("pluralForm", () => {
  const forms = { one: "one", few: "few", other: "other" };

  it("counts in two for English", () => {
    expect(pluralForm("en", 1, forms)).toBe("one");
    expect(pluralForm("en", 3, forms)).toBe("other");
  });

  it("counts in three for Czech", () => {
    expect(pluralForm("cs", 1, forms)).toBe("one");
    expect(pluralForm("cs", 3, forms)).toBe("few");
    expect(pluralForm("cs", 5, forms)).toBe("other");
  });

  it("falls back to other where a locale has no few form", () => {
    expect(pluralForm("cs", 3, { one: "one", other: "other" })).toBe("other");
  });
});

describe("catalogues", () => {
  it("cover exactly the same keys", () => {
    expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
  });

  it("agree on which entries are plural", () => {
    const shape = (catalog: Record<string, unknown>) =>
      Object.entries(catalog).filter(([, value]) => typeof value !== "string").map(([key]) => key).sort();
    expect(shape(cs)).toEqual(shape(en));
  });

  it("keep every placeholder the English text uses", () => {
    const placeholders = (value: unknown): string[] => typeof value === "string"
      ? [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
      : Object.values(value as Record<string, string>).flatMap(placeholders);
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const wanted = new Set(placeholders(en[key]));
      const got = new Set(placeholders(cs[key]));
      expect({ key, missing: [...wanted].filter((name) => !got.has(name)) }).toEqual({ key, missing: [] });
    }
  });
});
