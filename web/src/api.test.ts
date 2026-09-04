import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const optionsOf = (call = 0) => fetchMock.mock.calls[call][1] as RequestInit;

describe("request", () => {
  it("returns the parsed body", async () => {
    fetchMock.mockResolvedValue(json([{ key: "alpha" }]));
    await expect(api.addons()).resolves.toEqual([{ key: "alpha" }]);
  });

  it("sends JSON by default", async () => {
    fetchMock.mockResolvedValue(json({}));
    await api.addAddon("https://addon.example/manifest.json", "both");
    expect(optionsOf().headers).toMatchObject({ "content-type": "application/json" });
    expect(optionsOf().body).toBe(JSON.stringify({ url: "https://addon.example/manifest.json", role: "both" }));
  });

  it("does not try to parse an empty response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.deleteAddon("alpha")).resolves.toBeUndefined();
  });

  it("carries the status and code of a failure up to the caller", async () => {
    fetchMock.mockResolvedValue(json({ error: "Nepřihlášen", code: "AUTH" }, 401));
    const error = await api.addons().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "Nepřihlášen", status: 401, code: "AUTH" });
  });

  it("falls back to the status when the body carries no message", async () => {
    fetchMock.mockResolvedValue(new Response("<html>gateway</html>", { status: 502 }));
    await expect(api.addons()).rejects.toMatchObject({ message: "HTTP 502", status: 502, code: undefined });
  });

  it("turns a timeout into a 408, not an abort nobody can read", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(api.addons()).rejects.toMatchObject({ status: 408 });
  });

  it("passes a network failure through untouched", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.addons()).rejects.toThrow(TypeError);
  });

  it("gives every call a deadline", async () => {
    fetchMock.mockResolvedValue(json([]));
    await api.addons();
    expect(optionsOf().signal).toBeInstanceOf(AbortSignal);
  });
});

describe("query building", () => {
  const url = (call = 0) => fetchMock.mock.calls[call][0] as string;
  const catalog = { addonKey: "alpha", addonName: "Alpha", type: "movie", id: "top" };

  it("leaves out the parameters that were not given", async () => {
    fetchMock.mockResolvedValue(json([]));
    await api.catalog(catalog);
    expect(url()).toBe("/api/catalog?addon=alpha&type=movie&id=top");
  });

  it("includes the ones that were", async () => {
    fetchMock.mockResolvedValue(json([]));
    await api.catalog(catalog, "duna", 25, "sci-fi");
    expect(url()).toBe("/api/catalog?addon=alpha&type=movie&id=top&search=duna&skip=25&genre=sci-fi");
  });

  it("escapes identifiers that would otherwise break the path", async () => {
    fetchMock.mockResolvedValue(json({}));
    await api.meta("series", "tt123:1:2");
    expect(url()).toBe("/api/meta/series/tt123%3A1%3A2");
  });

  it("adds the addon filter to streams only when one is picked", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json([])));
    await api.streams("movie", "tt1");
    await api.streams("movie", "tt1", "alpha");
    expect(url(0)).toBe("/api/streams/movie/tt1");
    expect(url(1)).toBe("/api/streams/movie/tt1?addon=alpha");
  });
});
