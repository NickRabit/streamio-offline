import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MoveDialog } from "./MoveDialog";
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

const folders = (...names: string[]) => json({ path: "", folders: names.map((name) => ({ path: name, name })) });
const settle = async () => { await act(async () => { await Promise.resolve(); }); };
const confirmButton = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Move here"))!;
const click = async (element: Element) => { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };

const open = async (path: string, label: string, onMoved = vi.fn()) => {
  await act(async () => { root.render(<MoveDialog path={path} label={label} onClose={vi.fn()} onMoved={onMoved}/>); });
  await settle();
  return onMoved;
};

it("opens in the folder the item sits in and refuses a move that changes nothing", async () => {
  fetchMock.mockResolvedValue(folders("Season 1", "Season 2"));
  await open("Friends/pilot.mkv", "pilot");
  expect(fetchMock.mock.calls[0]?.[0]).toContain("path=Friends");
  expect(confirmButton().disabled).toBe(true);
  expect(host.textContent).toContain("The item is already in this folder.");
});

it("a folder cannot be moved into itself", async () => {
  fetchMock.mockResolvedValue(folders("Friends", "Archive"));
  await open("Friends", "Friends");
  const intoItself = [...host.querySelectorAll(".move-list button")].find((button) => button.textContent?.includes("Friends"))!;
  expect((intoItself as HTMLButtonElement).disabled).toBe(true);
});

it("moves into the picked folder and reports the new path", async () => {
  fetchMock.mockImplementation((url: string, options?: RequestInit) =>
    Promise.resolve(options?.method === "POST" ? json({ path: "Archive/pilot.mkv" }) : folders("Archive")));
  const onMoved = await open("Friends/pilot.mkv", "pilot");

  const archive = [...host.querySelectorAll(".move-list button")].find((button) => button.textContent?.includes("Archive"))!;
  await click(archive);
  await settle();
  expect(confirmButton().disabled).toBe(false);

  await click(confirmButton());
  await settle();
  const post = fetchMock.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === "POST")!;
  expect(post[0]).toBe("/api/library/move");
  expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ path: "Friends/pilot.mkv", folder: "Archive" });
  expect(onMoved).toHaveBeenCalledWith("Archive/pilot.mkv");
});

it("the library root is a destination of its own", async () => {
  fetchMock.mockResolvedValue(folders("Archive"));
  await open("Friends/pilot.mkv", "pilot");
  const rootCrumb = host.querySelector(".move-crumbs button")!;
  await click(rootCrumb);
  await settle();
  expect(confirmButton().disabled).toBe(false);
  expect(host.textContent).toContain("Moves into Library.");
});
