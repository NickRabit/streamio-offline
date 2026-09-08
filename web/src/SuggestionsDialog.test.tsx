import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SuggestionsDialog } from "./SuggestionsDialog";
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

const rows = {
  items: [{ key: "Father Ted", label: "Father Ted", suggestion: { type: "series", id: "tt0111958", name: "Father Ted", year: 1995, score: 88 } }],
  total: 1,
};

describe("SuggestionsDialog", () => {
  it("confirms a suggestion and drops the row", async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/suggestions")) return Promise.resolve(json(rows));
      if (String(url).includes("/api/library/match")) return Promise.resolve(json({ key: "Father Ted", type: "series", id: "tt0111958" }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<SuggestionsDialog onClose={() => undefined} onChanged={onChanged} onIdentify={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("Father Ted");
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Confirm"));
    await act(async () => { confirm!.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes("/api/library/match"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({ path: "Father Ted", id: "tt0111958", type: "series" });
    expect(onChanged).toHaveBeenCalled();
    expect(host.textContent).toContain("Nothing is waiting");
  });

  it("dismisses a suggestion through the delete endpoint", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/suggestions")) return Promise.resolve(json(rows));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await act(async () => { root.render(<SuggestionsDialog onClose={() => undefined} onChanged={() => undefined} onIdentify={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    const dismiss = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Dismiss"));
    await act(async () => { dismiss!.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes("/api/library/suggestion?"));
    expect(call?.[1]).toMatchObject({ method: "DELETE" });
  });
});
