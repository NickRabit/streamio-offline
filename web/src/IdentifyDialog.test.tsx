import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IdentifyDialog } from "./IdentifyDialog";
import { setLocale } from "./i18n";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const identity = {
  path: "Father Ted",
  key: "Father Ted",
  kind: "series" as const,
  parsed: { title: "Father Ted", query: "Father Ted", year: 1995 },
  match: "unmatched" as const,
  suggestion: { type: "series", id: "tt0111958", name: "Father Ted", year: 1995, score: 92 },
};

describe("IdentifyDialog", () => {
  it("prefills series kind and searches", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/identity")) return Promise.resolve(json(identity));
      if (String(url).includes("/api/search")) return Promise.resolve(json({
        items: [{ id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995" }],
        hasMore: false, cursor: "", sources: 1,
      }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<IdentifyDialog path="Father Ted" onClose={() => undefined} onApplied={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector("input")?.value).toBe("Father Ted");
    expect(host.textContent).toContain("Series");
    expect(host.textContent).toContain("Father Ted");
    const searchCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/search"));
    expect(String(searchCall?.[0])).toContain("type=series");
  });

  it("applies the picked title", async () => {
    const onApplied = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("/api/library/identity")) return Promise.resolve(json(identity));
      if (String(url).includes("/api/search")) return Promise.resolve(json({
        items: [{ id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995" }],
        hasMore: false, cursor: "", sources: 1,
      }));
      if (String(url).includes("/api/library/match")) return Promise.resolve(json({ key: "Father Ted", type: "series", id: "tt0111958" }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<IdentifyDialog path="Father Ted" onClose={() => undefined} onApplied={onApplied}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const apply = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Use this title"));
    expect(apply).toBeTruthy();
    await act(async () => { apply!.click(); });
    await act(async () => { await Promise.resolve(); });
    const matchCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/library/match"));
    expect(matchCall?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((matchCall?.[1] as RequestInit).body))).toMatchObject({ path: "Father Ted", id: "tt0111958", type: "series" });
    expect(onApplied).toHaveBeenCalled();
  });

  it("shows the locked hint when the title was unmatched", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/identity")) return Promise.resolve(json({ ...identity, match: "rejected" }));
      if (String(url).includes("/api/search")) return Promise.resolve(json({ items: [], hasMore: false, cursor: "", sources: 1 }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<IdentifyDialog path="Father Ted" onClose={() => undefined} onApplied={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("Catalog lookup is off");
  });
});
