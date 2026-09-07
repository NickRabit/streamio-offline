import { describe, expect, it } from "vitest";
import { arrangeStreams, canQueue, pickDefaultStream, streamBadge, streamSize, streamText, visibleCatalogStreams, type StreamFilters } from "./streams";
import type { Stream } from "./types";

const stream = (parts: Partial<Stream>): Stream => ({ sourceId: "source", kind: "remote", playable: true, ...parts });
const names = (list: Stream[]) => list.map((item) => item.name);
const filters = (overrides: Partial<StreamFilters> = {}): StreamFilters =>
  ({ addon: "", language: "", sort: "recommended", ...overrides });

describe("streamText", () => {
  it("joins every field an addon may have used", () => {
    expect(streamText(stream({ name: "A", title: "B", description: "C", behaviorHints: { filename: "D.mkv" } })))
      .toBe("A B C D.mkv");
  });

  it("skips fields the addon left out", () => {
    expect(streamText(stream({ name: "A", description: "C" }))).toBe("A C");
  });
});

describe("streamSize", () => {
  it("prefers the structured hint", () => {
    expect(streamSize(stream({ title: "\u{1F4BE} 1 GB", behaviorHints: { videoSize: 12345 } }))).toBe(12345);
  });

  it("ignores a zero hint and falls back to the text", () => {
    expect(streamSize(stream({ title: "500 MB", behaviorHints: { videoSize: 0 } }))).toBe(500e6);
  });

  it("parses the units addons actually write", () => {
    expect(streamSize(stream({ title: "\u{1F4BE} 35.09 GB" }))).toBe(35_090_000_000);
    expect(streamSize(stream({ title: "700 MB" }))).toBe(700e6);
    expect(streamSize(stream({ title: "1.5 TB" }))).toBe(1.5e12);
    expect(streamSize(stream({ title: "820 KB" }))).toBe(820e3);
  });

  it("accepts a decimal comma", () => {
    expect(streamSize(stream({ title: "2,5 GB" }))).toBe(2.5e9);
  });

  it("accepts the unit written straight after the number", () => {
    expect(streamSize(stream({ title: "4GB" }))).toBe(4e9);
  });

  it("is case-insensitive", () => {
    expect(streamSize(stream({ title: "3 gb" }))).toBe(3e9);
  });

  it("returns nothing when no size is mentioned", () => {
    expect(streamSize(stream({ title: "1080p WEB-DL" }))).toBeUndefined();
  });

  it("does not read a unit glued to a longer word", () => {
    expect(streamSize(stream({ title: "10 GBps link" }))).toBeUndefined();
  });
});

describe("arrangeStreams", () => {
  const czechSmall = stream({ name: "cz-small", title: "Czech 1 GB", addonName: "alpha" });
  const czechBig = stream({ name: "cz-big", title: "Czech 8 GB", addonName: "beta" });
  const englishBig = stream({ name: "en-big", title: "English 20 GB", addonName: "alpha" });
  const unknown = stream({ name: "unknown", title: "1080p", addonName: "beta" });
  const all = [englishBig, czechSmall, unknown, czechBig];

  it("filters by addon", () => {
    expect(names(arrangeStreams(all, filters({ addon: "alpha" }), "cs")))
      .toEqual(["cz-small", "en-big"]);
  });

  it("filters by language", () => {
    expect(names(arrangeStreams(all, filters({ language: "cs" }), "cs")).sort())
      .toEqual(["cz-big", "cz-small"]);
  });

  it("puts the preferred language first, then the largest", () => {
    expect(names(arrangeStreams(all, filters(), "cs")))
      .toEqual(["cz-big", "cz-small", "en-big", "unknown"]);
  });

  it("respects addon priority inside the preferred language", () => {
    const priority = new Map([["beta", 0], ["alpha", 1]]);
    expect(names(arrangeStreams([czechSmall, czechBig], filters(), "cs", priority)))
      .toEqual(["cz-big", "cz-small"]);
    expect(names(arrangeStreams([czechBig, czechSmall], filters(), "en", priority)))
      .toEqual(["cz-big", "cz-small"]);
  });

  it("sorts by size in both directions", () => {
    expect(names(arrangeStreams(all, filters({ sort: "size-desc" }), "cs")))
      .toEqual(["en-big", "cz-big", "cz-small", "unknown"]);
    expect(names(arrangeStreams(all, filters({ sort: "size-asc" }), "cs")))
      .toEqual(["cz-small", "cz-big", "en-big", "unknown"]);
  });

  it("keeps an unknown size last when sorting ascending", () => {
    expect(names(arrangeStreams([unknown, czechSmall], filters({ sort: "size-asc" }), "cs")))
      .toEqual(["cz-small", "unknown"]);
  });

  it("sorts by addon priority and keeps the addon's own order inside a group", () => {
    const priority = new Map([["beta", 0], ["alpha", 1]]);
    expect(names(arrangeStreams(all, filters({ sort: "addon" }), "cs", priority)))
      .toEqual(["unknown", "cz-big", "en-big", "cz-small"]);
  });

  it("puts addons with no priority last", () => {
    const priority = new Map([["beta", 0]]);
    expect(names(arrangeStreams(all, filters({ sort: "addon" }), "cs", priority)))
      .toEqual(["unknown", "cz-big", "en-big", "cz-small"]);
  });

  it("leaves the input array untouched", () => {
    const input = [...all];
    arrangeStreams(input, filters({ sort: "size-desc" }), "cs");
    expect(input).toEqual(all);
  });
});

describe("torrent listing", () => {
  const http = stream({ name: "http", playable: true, kind: "remote", title: "Czech 1 GB" });
  const torrent = stream({ name: "torrent", playable: false, kind: "torrent", title: "Czech 8 GB" });
  const external = stream({ name: "ext", playable: false, kind: "unsupported", title: "Czech 2 GB" });

  it("hides torrents until a debrid token is configured", () => {
    expect(names(visibleCatalogStreams([torrent, http], filters(), "cs", new Map(), false))).toEqual(["http"]);
    expect(names(visibleCatalogStreams([torrent, http], filters(), "cs", new Map(), true))).toEqual(["torrent", "http"]);
  });

  it("prefers a playable HTTP source over a torrent", () => {
    expect(pickDefaultStream([torrent, http])?.name).toBe("http");
    expect(pickDefaultStream([torrent])?.name).toBe("torrent");
  });

  it("labels torrents as RD, not as a generic external source", () => {
    expect(streamBadge(http)).toBe("HTTP");
    expect(streamBadge(torrent)).toBe("RD");
    expect(streamBadge(external)).toBe("EXT");
  });

  it("lets a torrent be queued only when Real-Debrid is configured", () => {
    expect(canQueue(torrent, false)).toBe(false);
    expect(canQueue(torrent, true)).toBe(true);
    expect(canQueue(http, false)).toBe(true);
  });
});
