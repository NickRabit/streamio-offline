import assert from "node:assert/strict";
import test from "node:test";
import { localDay, summarize, type DownloadEvent } from "./stats.js";

const GB = 1024 ** 3;
const now = new Date("2026-09-02T18:00:00");
const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();

const event = (hours: number, bytes: number, provider: string, addon = provider): DownloadEvent =>
  ({ at: ago(hours), bytes, provider, addonKey: addon, addonName: addon, title: `Film ${hours}`, kind: "movie" });

const sample: DownloadEvent[] = [
  event(1, 2 * GB, "cdn.jedna.cz"),
  event(10, 1 * GB, "cdn.dva.cz"),
  event(50, 3 * GB, "cdn.jedna.cz"),
  event(200, 4 * GB, "cdn.tri.cz"),
  event(1000, 5 * GB, "cdn.dva.cz"),
];

test("okna za den, týden a měsíc sčítají jen svoje období", () => {
  const summary = summarize(sample, 30, now);
  assert.deepEqual(summary.day, { bytes: 3 * GB, count: 2 });
  assert.deepEqual(summary.week, { bytes: 6 * GB, count: 3 });
  assert.deepEqual(summary.month, { bytes: 10 * GB, count: 4 });
  assert.deepEqual(summary.total, { bytes: 15 * GB, count: 5 });
});

test("řada dnů je souvislá a končí dneškem", () => {
  const summary = summarize(sample, 30, now);
  assert.equal(summary.days.length, 30);
  assert.equal(summary.days.at(-1)?.date, localDay(now));
  const dayMs = 24 * 3600_000;
  for (let index = 1; index < summary.days.length; index += 1) {
    const previous = Date.parse(summary.days[index - 1].date);
    assert.equal(Date.parse(summary.days[index].date) - previous, dayMs, "v řadě nesmí chybět den");
  }
  assert.equal(summary.days.reduce((sum, day) => sum + day.bytes, 0), 10 * GB);
});

test("poskytovatelé se sčítají a řadí od největšího", () => {
  const { providers } = summarize(sample, 30, now);
  assert.deepEqual(providers.map((item) => item.key), ["cdn.jedna.cz", "cdn.tri.cz", "cdn.dva.cz"]);
  assert.deepEqual(providers[0], { key: "cdn.jedna.cz", label: "cdn.jedna.cz", bytes: 5 * GB, count: 2 });
});

test("kratší období odřízne starší poskytovatele, okna zůstanou", () => {
  const summary = summarize(sample, 2, now);
  assert.equal(summary.days.length, 2);
  assert.deepEqual(summary.providers.map((item) => item.key), ["cdn.jedna.cz", "cdn.dva.cz"]);
  assert.deepEqual(summary.month, { bytes: 10 * GB, count: 4 }, "okna se počítají nezávisle na zvoleném období");
});

test("večerní stahování patří do místního dne, ne do UTC", () => {
  const late: DownloadEvent[] = [{ ...event(0, GB, "cdn.jedna.cz"), at: "2026-09-02T23:30:00+02:00" }];
  const summary = summarize(late, 3, new Date("2026-09-02T23:45:00+02:00"));
  assert.equal(summary.days.at(-1)?.bytes, GB, "má spadnout do 2. září, i když je v UTC už 3.");
});

test("prázdný záznam nespadne", () => {
  const summary = summarize([], 7, now);
  assert.deepEqual(summary.total, { bytes: 0, count: 0 });
  assert.equal(summary.days.length, 7);
  assert.deepEqual(summary.providers, []);
  assert.equal(summary.since, undefined);
});
