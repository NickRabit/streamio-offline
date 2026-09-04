import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const secureContext = (value: boolean) =>
  Object.defineProperty(window, "isSecureContext", { value, configurable: true });

const withClipboard = (writeText?: () => Promise<void>) =>
  Object.defineProperty(navigator, "clipboard", { value: writeText ? { writeText } : undefined, configurable: true });

afterEach(() => {
  secureContext(false);
  withClipboard(undefined);
  Reflect.deleteProperty(document, "execCommand");
});

describe("copyText", () => {
  it("uses the clipboard API in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    secureContext(true);
    withClipboard(writeText);
    const execCommand = vi.fn();
    document.execCommand = execCommand;

    await copyText("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a selection when the API is missing, as it is over plain HTTP", async () => {
    secureContext(false);
    withClipboard(vi.fn());
    let copied: string | undefined;
    document.execCommand = vi.fn(() => {
      copied = document.querySelector("textarea")?.value;
      return true;
    });

    await copyText("over http");

    expect(copied).toBe("over http");
  });

  it("falls back when the clipboard API rejects", async () => {
    secureContext(true);
    withClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    document.execCommand = vi.fn(() => true);

    await expect(copyText("retry")).resolves.toBeUndefined();
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("removes its scratch element whether the fallback works or not", async () => {
    document.execCommand = vi.fn(() => true);
    await copyText("clean");
    expect(document.querySelector("textarea")).toBeNull();

    document.execCommand = vi.fn(() => false);
    await copyText("dirty").catch(() => undefined);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports a refusal instead of failing silently", async () => {
    document.execCommand = vi.fn(() => false);
    await expect(copyText("nope")).rejects.toThrow(/ručně/);
  });

  it("reports a refusal when execCommand throws", async () => {
    document.execCommand = vi.fn(() => { throw new Error("blocked"); });
    await expect(copyText("nope")).rejects.toThrow(/ručně/);
  });
});
