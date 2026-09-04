import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostOf, report } from "./diagnostics";

describe("hostOf", () => {
  it("keeps only the host, so tokens in the path are never sent", () => {
    expect(hostOf("https://cdn.example.com/stream/secret-token/file.mkv")).toBe("cdn.example.com");
  });

  it("keeps a non-default port", () => {
    expect(hostOf("http://nas.local:8090/api")).toBe("nas.local:8090");
  });

  it("resolves a relative address against the page", () => {
    expect(hostOf("/api/playback/1")).toBe(location.host);
  });

  it("returns nothing for a missing or unusable address", () => {
    expect(hostOf(undefined)).toBeUndefined();
    expect(hostOf("")).toBeUndefined();
    expect(hostOf("http://")).toBeUndefined();
  });
});

describe("report", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body as string);

  it("posts the level, message and context together with the page", () => {
    report("ERROR", "Playback stalled", { host: "cdn.example.com" });

    expect(fetchMock).toHaveBeenCalledWith("/api/client-log", expect.objectContaining({ method: "POST", keepalive: true }));
    expect(bodyOf(0)).toEqual({
      level: "ERROR",
      message: "Playback stalled",
      context: { host: "cdn.example.com", page: location.pathname },
    });
  });

  it("swallows a repeat of the same message", () => {
    report("WARN", "Buffering");
    report("WARN", "Buffering");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets the same message through again once the window has passed", () => {
    report("WARN", "Seek failed");
    vi.advanceTimersByTime(5001);
    report("WARN", "Seek failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not suppress a different message", () => {
    report("WARN", "First problem");
    report("WARN", "Second problem");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never rejects when the server is unreachable", () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(() => report("ERROR", "Cannot reach server")).not.toThrow();
  });
});
