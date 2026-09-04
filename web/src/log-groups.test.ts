import { describe, expect, it } from "vitest";
import { groupLog, parseLog } from "./log-groups";

const line = (level: string, message: string, at = "2026-01-02T03:04:05.000Z") => `${at} ${level} ${message}`;

describe("parseLog", () => {
  it("splits a line into time, level and message", () => {
    const [entry] = parseLog(line("ERROR", "Conversion failed"));
    expect(entry).toMatchObject({ at: "2026-01-02T03:04:05.000Z", level: "ERROR", message: "Conversion failed" });
    expect(entry.context).toBeUndefined();
  });

  it("separates the JSON context from the message", () => {
    const [entry] = parseLog(line("WARN", 'Slow start {"session":"a1"}'));
    expect(entry.message).toBe("Slow start");
    expect(entry.context).toBe('{"session":"a1"}');
  });

  it("splits a stack trace into one record per line", () => {
    const entries = parseLog(line("ERROR", "Stack:\n  at foo\n  at bar"));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ level: "ERROR", message: "Stack:" });
    expect(entries.slice(1).map((entry) => entry.level)).toEqual(["", ""]);
  });

  it("keeps a line it cannot parse as raw text", () => {
    const [entry] = parseLog("ffmpeg wrote this itself");
    expect(entry).toMatchObject({ at: "", level: "", message: "ffmpeg wrote this itself" });
  });

  it("drops blank lines", () => {
    expect(parseLog("\n\n")).toEqual([]);
  });
});

describe("groupLog", () => {
  it("counts repeats of the same message as one group", () => {
    const groups = groupLog(parseLog([
      line("ERROR", "Stream 12 failed", "2026-01-02T03:00:00.000Z"),
      line("ERROR", "Stream 47 failed", "2026-01-02T03:01:00.000Z"),
    ].join("\n")));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 2, first: "2026-01-02T03:00:00.000Z", last: "2026-01-02T03:01:00.000Z" });
  });

  it("treats session identifiers as noise", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const other = "8c4e5f21-1111-4444-8888-0305e82c3301";
    const groups = groupLog(parseLog([line("WARN", `Session ${id} idle`), line("WARN", `Session ${other} idle`)].join("\n")));
    expect(groups).toHaveLength(1);
  });

  it("keeps different messages apart", () => {
    const groups = groupLog(parseLog([line("ERROR", "Disk full"), line("ERROR", "Addon unreachable")].join("\n")));
    expect(groups).toHaveLength(2);
  });

  it("keeps the same message on different levels apart", () => {
    const groups = groupLog(parseLog([line("WARN", "Retrying"), line("ERROR", "Retrying")].join("\n")));
    expect(groups).toHaveLength(2);
  });

  it("keeps only the last few samples, newest first", () => {
    const text = Array.from({ length: 5 }, (_, i) => line("ERROR", "Boom", `2026-01-02T03:0${i}:00.000Z`)).join("\n");
    const [group] = groupLog(parseLog(text));
    expect(group.count).toBe(5);
    expect(group.samples).toHaveLength(3);
    expect(group.samples.map((sample) => sample.at)).toEqual([
      "2026-01-02T03:04:00.000Z", "2026-01-02T03:03:00.000Z", "2026-01-02T03:02:00.000Z",
    ]);
  });

  it("sorts by severity first, then by recency", () => {
    const groups = groupLog(parseLog([
      line("WARN", "Older warning", "2026-01-02T03:00:00.000Z"),
      line("ERROR", "Older error", "2026-01-02T03:01:00.000Z"),
      line("WARN", "Newer warning", "2026-01-02T03:02:00.000Z"),
      line("ERROR", "Newer error", "2026-01-02T03:03:00.000Z"),
    ].join("\n")));
    expect(groups.map((group) => group.message))
      .toEqual(["Newer error", "Older error", "Newer warning", "Older warning"]);
  });

  it("keeps only the levels asked for", () => {
    const text = [line("INFO", "Started"), line("ERROR", "Failed")].join("\n");
    expect(groupLog(parseLog(text)).map((group) => group.level)).toEqual(["ERROR"]);
    expect(groupLog(parseLog(text), ["INFO"]).map((group) => group.level)).toEqual(["INFO"]);
  });

  it("keeps everything when no level is requested", () => {
    const text = [line("DEBUG", "Tick"), line("INFO", "Started")].join("\n");
    expect(groupLog(parseLog(text), [])).toHaveLength(2);
  });
});
