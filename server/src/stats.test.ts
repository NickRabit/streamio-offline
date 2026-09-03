import assert from "node:assert/strict";
import test from "node:test";
import { compact, summarize, type TrafficEvent, type TrafficSource } from "./stats.js";

const GB = 1024 ** 3;
const now = new Date("2026-09-02T18:00:00");
const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();

const event = (hours: number, bytes: number, provider: string, addon = provider, source: TrafficSource = "download"): TrafficEvent =>
  ({ at: ago(hours), bytes, items: 1, source, provider, addonKey: addon, addonName: addon, title: `Film ${hours}`, kind: "movie" });

const sample: TrafficEvent[] = [
  event(0.2, 2 * GB, "cdn.jedna.cz"),
  event(10, 1 * GB, "cdn.dva.cz"),
  event(50, 3 * GB, "cdn.jedna.cz"),
  event(200, 4 * GB, "cdn.tri.cz"),
  event(1000, 5 * GB, "cdn.dva.cz"),
];

test("okna se počítají nezávisle na zvoleném období", () => {
  for (const hours of [1, 24, 720]) {
    const summary = summarize(sample, hours, now);
    assert.deepEqual(summary.hour, { bytes: 2 * GB, count: 1 }, `hodina při období ${hours} h`);
    assert.deepEqual(summary.day, { bytes: 3 * GB, count: 2 });
    assert.deepEqual(summary.week, { bytes: 6 * GB, count: 3 });
    assert.deepEqual(summary.month, { bytes: 10 * GB, count: 4 });
    assert.deepEqual(summary.total, { bytes: 15 * GB, count: 5 });
  }
});

test("hodinové období se dělí po pěti minutách", () => {
  const summary = summarize(sample, 1, now);
  assert.equal(summary.step, "minute");
  assert.equal(summary.points.length, 12);
  assert.equal(summary.points.reduce((sum, point) => sum + point.bytes, 0), 2 * GB, "do hodiny spadne jen nejnovější");
  const gap = Date.parse(summary.points[1].at) - Date.parse(summary.points[0].at);
  assert.equal(gap, 5 * 60_000);
});

test("denní období se dělí po hodinách", () => {
  const summary = summarize(sample, 24, now);
  assert.equal(summary.step, "hour");
  assert.equal(summary.points.length, 24);
  assert.equal(summary.points.reduce((sum, point) => sum + point.bytes, 0), 3 * GB);
  assert.equal(Date.parse(summary.points[1].at) - Date.parse(summary.points[0].at), 3600_000);
});

test("delší období jde po dnech a řada je souvislá", () => {
  const summary = summarize(sample, 30 * 24, now);
  assert.equal(summary.step, "day");
  assert.equal(summary.points.length, 30);
  assert.equal(summary.points.reduce((sum, point) => sum + point.bytes, 0), 10 * GB);
  for (let index = 1; index < summary.points.length; index += 1) {
    const gap = Date.parse(summary.points[index].at) - Date.parse(summary.points[index - 1].at);
    assert.ok(gap >= 23 * 3600_000 && gap <= 25 * 3600_000, `mezi dny má být jeden den, bylo ${gap} ms`);
  }
});

test("poskytovatelé i doplňky se sčítají a řadí od největšího", () => {
  const { providers, addons } = summarize(sample, 30 * 24, now);
  assert.deepEqual(providers.map((item) => item.key), ["cdn.jedna.cz", "cdn.tri.cz", "cdn.dva.cz"]);
  assert.deepEqual(providers[0], { key: "cdn.jedna.cz", label: "cdn.jedna.cz", bytes: 5 * GB, count: 2 });
  assert.deepEqual(addons.map((item) => item.key), providers.map((item) => item.key));
});

test("každý zdroj má vlastní řadu ve stejném pořadí jako v přehledu", () => {
  const summary = summarize(sample, 30 * 24, now);
  assert.deepEqual(summary.byProvider.map((line) => line.key), summary.providers.map((item) => item.key));
  for (const line of summary.byProvider) {
    assert.equal(line.points.length, summary.points.length, "řada musí mít stejně bodů jako graf");
    const total = summary.providers.find((item) => item.key === line.key)!.bytes;
    assert.equal(line.points.reduce((sum, value) => sum + value, 0), total, `součet řady ${line.key}`);
  }
  const perPoint = summary.points.map((_, index) => summary.byProvider.reduce((sum, line) => sum + line.points[index], 0));
  assert.deepEqual(perPoint, summary.points.map((point) => point.bytes), "řady dohromady dají celkový graf");
});

test("večerní stahování patří do místního dne, ne do UTC", () => {
  const late: TrafficEvent[] = [{ ...event(0, GB, "cdn.jedna.cz"), at: "2026-09-02T23:30:00+02:00" }];
  const summary = summarize(late, 3 * 24, new Date("2026-09-02T23:45:00+02:00"));
  assert.equal(summary.points.at(-1)?.bytes, GB, "má spadnout do 2. září, i když je v UTC už 3.");
});

test("prázdný záznam nespadne", () => {
  const summary = summarize([], 7 * 24, now);
  assert.deepEqual(summary.total, { bytes: 0, count: 0 });
  assert.equal(summary.points.length, 7);
  assert.deepEqual(summary.providers, []);
  assert.deepEqual(summary.byProvider, []);
  assert.equal(summary.since, undefined);
});

test("přehrávání z knihovny nepatří do externího provozu", () => {
  const events = [...sample, event(0.3, 9 * GB, "knihovna", "knihovna", "library")];
  const summary = summarize(events, 30 * 24, now);
  assert.deepEqual(summary.hour, { bytes: 2 * GB, count: 1 }, "lokální přehrávání kartu nezvedá");
  assert.equal(summary.points.reduce((sum, point) => sum + point.bytes, 0), 10 * GB, "ani sloupce");
  assert.ok(!summary.providers.some((item) => item.key === "knihovna"), "ani rozpad podle zdroje");
});

test("druhy provozu se rozpadají včetně knihovny a mají vlastní řadu", () => {
  const events = [
    event(0.3, 1 * GB, "cdn.jedna.cz"),
    event(0.4, 2 * GB, "cdn.dva.cz", "cdn.dva.cz", "catalog"),
    event(0.5, 4 * GB, "knihovna", "knihovna", "library"),
  ];
  const summary = summarize(events, 24, now);
  assert.deepEqual(summary.sources.map((item) => item.key), ["library", "catalog", "download"]);
  assert.deepEqual(summary.bySource.map((line) => line.key), summary.sources.map((item) => item.key));
  const library = summary.bySource.find((line) => line.key === "library")!;
  assert.equal(library.points.reduce((sum, value) => sum + value, 0), 4 * GB);
  assert.deepEqual(summary.total, { bytes: 3 * GB, count: 2 }, "celkem je jen externí provoz");
});

test("průběžné přírůstky se počítají jako jedna položka", () => {
  const chunks: TrafficEvent[] = [
    { ...event(3, 1 * GB, "cdn.jedna.cz"), items: 0 },
    { ...event(2, 1 * GB, "cdn.jedna.cz"), items: 0 },
    { ...event(1, 0, "cdn.jedna.cz"), items: 1 },
  ];
  const summary = summarize(chunks, 24, now);
  assert.deepEqual(summary.day, { bytes: 2 * GB, count: 1 });
  const spread = summary.points.filter((point) => point.bytes).length;
  assert.equal(spread, 2, "bajty patří do hodin, kdy tekly, ne do jediného sloupce");
});

test("starší záznamy se slučují po hodinách, součty zůstávají", () => {
  const old = new Date(now.getTime() - 50 * 3600_000);
  const at = (minutes: number) => new Date(old.getTime() + minutes * 60_000).toISOString();
  const events: TrafficEvent[] = [
    { ...event(50, 1 * GB, "cdn.jedna.cz"), at: at(1), items: 0 },
    { ...event(50, 2 * GB, "cdn.jedna.cz"), at: at(20), items: 0 },
    { ...event(50, 0, "cdn.jedna.cz"), at: at(40), items: 1 },
    { ...event(50, 1 * GB, "cdn.dva.cz"), at: at(70), items: 1 },
    event(2, 5 * GB, "cdn.jedna.cz"),
  ];
  const merged = compact(events, now.getTime() - 24 * 3600_000);
  assert.equal(merged.length, 3, "tři záznamy z jedné hodiny a zdroje se slijí do jednoho");
  assert.equal(merged.reduce((sum, item) => sum + item.bytes, 0), 9 * GB);
  assert.equal(merged.reduce((sum, item) => sum + item.items, 0), 3);
  assert.deepEqual(summarize(merged, 90 * 24, now).total, summarize(events, 90 * 24, now).total);
});
