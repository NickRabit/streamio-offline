import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { flushLog, initLogger, log, readLog } from "./logger.js";

const withLogger = async (env: Record<string, string | undefined>, body: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-logger-"));
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { LOG_STDOUT: "0", LOG_LEVEL: undefined, LOG_MAX_BYTES: undefined, ...env });
    await initLogger(directory);
    await body(directory);
  } finally {
    process.env = previous;
    await rm(directory, { recursive: true, force: true });
  }
};

const contents = async (directory: string) => {
  await flushLog();
  return readFile(path.join(directory, "app.log"), "utf8").catch(() => "");
};

test("entries below the configured level are dropped", async () => {
  await withLogger({ LOG_LEVEL: "WARN" }, async (directory) => {
    log("DEBUG", "debug entry"); log("INFO", "info entry"); log("WARN", "warn entry"); log("ERROR", "error entry");
    const text = await contents(directory);
    assert.equal(text.includes("debug entry"), false);
    assert.equal(text.includes("info entry"), false);
    assert.match(text, /WARN warn entry/);
    assert.match(text, /ERROR error entry/);
  });
});

test("an unknown LOG_LEVEL falls back to INFO", async () => {
  await withLogger({ LOG_LEVEL: "chatty" }, async (directory) => {
    log("DEBUG", "debug entry"); log("INFO", "info entry");
    const text = await contents(directory);
    assert.equal(text.includes("debug entry"), false);
    assert.match(text, /INFO info entry/);
  });
});

test("addresses lose their query string and sensitive keys are masked", async () => {
  await withLogger({}, async (directory) => {
    log("INFO", "source connected", {
      url: "https://cdn.example.com/movie/file.mkv?token=abc123&exp=99",
      reason: "ffmpeg failed on http://user:pw@cdn.example.com/a/b.m3u8?key=secret",
      accessToken: "abc123",
      nested: { cookie: "session=1", host: "cdn.example.com" },
    });
    const text = await contents(directory);
    assert.equal(text.includes("abc123"), false);
    assert.equal(text.includes("token="), false);
    assert.equal(text.includes("session=1"), false);
    assert.match(text, /https:\/\/cdn\.example\.com/);
    assert.match(text, /"accessToken":"\*\*\*"/);
    assert.match(text, /"host":"cdn\.example\.com"/);
  });
});

test("the file rotates once it passes the size cap and history stays readable", async () => {
  await withLogger({ LOG_MAX_BYTES: "65536" }, async (directory) => {
    // Roughly 450 bytes per line, so a 64 KB cap rotates once somewhere past entry 140.
    for (let index = 0; index < 200; index += 1) log("INFO", `entry ${index}`, { filler: "x".repeat(400) });
    await flushLog();
    const current = await readFile(path.join(directory, "app.log"), "utf8");
    const rotated = await readFile(path.join(directory, "app.log.1"), "utf8");
    assert.ok(Buffer.byteLength(current) <= 65536);
    assert.ok(rotated.includes("entry 0"));
    assert.match(current, /entry 199/);
    assert.match(await readLog({}), /entry 0 [\s\S]*entry 199 /);
  });
});

test("readLog filters by level and returns only the requested tail", async () => {
  await withLogger({}, async () => {
    log("INFO", "first"); log("WARN", "second"); log("ERROR", "third"); log("INFO", "fourth");
    await flushLog();
    const warnings = await readLog({ level: "WARN" });
    assert.match(warnings, /second/); assert.match(warnings, /third/);
    assert.equal(warnings.includes("first"), false);
    const tail = await readLog({ tail: 1 });
    assert.match(tail, /fourth/);
    assert.equal(tail.includes("third"), false);
  });
});

test("an empty log reports that instead of failing", async () => {
  await withLogger({}, async (directory) => {
    await writeFile(path.join(directory, "app.log"), "");
    assert.match(await readLog({}), /no entries/);
  });
});
