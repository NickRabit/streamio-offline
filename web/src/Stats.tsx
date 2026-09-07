import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { StatsSeries, StatsSummary } from "./types";
import { localeTag, t, useI18n } from "./i18n";

const size = (value: number) => !value ? "0 B"
  : value >= 1e12 ? `${(value / 1e12).toFixed(2)} TB`
  : value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB`
  : value >= 1e6 ? `${Math.round(value / 1e6)} MB`
  : `${Math.round(value / 1e3)} kB`;

const files = (count: number) => t("stats.items", { count });

const PERIODS = [
  { hours: 1, key: "stats.period.hour" },
  { hours: 24, key: "stats.period.day" },
  { hours: 168, key: "stats.period.week" },
  { hours: 720, key: "stats.period.month" },
  { hours: 2160, key: "stats.period.quarter" },
  { hours: 8760, key: "stats.period.year" },
] as const;

/** Colours for the picked series. The shades are checked against the panel's dark
 * ground: they hold one lightness band, keep their saturation and stay apart under
 * colour blindness, so neighbouring lines never merge. More than eight sources at
 * once cannot be told apart anyway. */
const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** Five ticks on the Y axis, derived from the peak so the scale stays readable. */
const TICKS = [1, 0.75, 0.5, 0.25, 0];

/** Only a few labels fit on the X axis before they overlap. */
const xTicks = (count: number) => {
  const wanted = Math.min(6, count);
  if (wanted < 2) return [0];
  return Array.from({ length: wanted }, (_, index) => Math.round((index * (count - 1)) / (wanted - 1)));
};

const stamp = (at: string, step: StatsSummary["step"]) => {
  const date = new Date(at);
  if (step === "day") return date.toLocaleDateString(localeTag(), { day: "numeric", month: "numeric" });
  return date.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" });
};

function Card({ title, window }: { title: string; window: { bytes: number; count: number } }) {
  return <div className="stats-card">
    <small>{title}</small>
    <strong>{size(window.bytes)}</strong>
    <span>{files(window.count)}</span>
  </div>;
}

/** With nothing picked the total volume is drawn as bars; a pick gives every series
 * its own line. */
function Chart({ summary, lines }: { summary: StatsSummary; lines: Array<StatsSeries & { color: string; dashed?: boolean }> }) {
  const peak = Math.max(1, ...(lines.length ? lines.flatMap((line) => line.points) : summary.points.map((point) => point.bytes)));
  const width = 1000, height = 200;
  const stride = summary.points.length > 1 ? width / (summary.points.length - 1) : width;
  const marks = xTicks(summary.points.length);

  return <div className="stats-plot">
    <div className="stats-yaxis">
      {TICKS.map((tick) => <span key={tick} style={{ bottom: `${tick * 100}%` }}>{size(peak * tick)}</span>)}
    </div>

    <div className="stats-area">
      <div className="stats-grid" aria-hidden="true">{TICKS.map((tick) => <i key={tick} style={{ bottom: `${tick * 100}%` }}/>)}</div>
      {lines.length
        ? <>
            <svg className="stats-lines" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("stats.chosenTrend")}>
              {lines.map((line) => <polyline key={line.key} fill="none" stroke={line.color} strokeWidth={2} vectorEffect="non-scaling-stroke"
                strokeDasharray={line.dashed ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round"
                points={line.points.map((value, index) => `${index * stride},${height - (value / peak) * (height - 6)}`).join(" ")}/>)}
            </svg>
            {/* Transparent columns over the chart carry the tooltip with every picked series. */}
            <div className="stats-hover">
              {summary.points.map((point, index) => <div key={point.at}
                title={`${stamp(point.at, summary.step)}\n${lines.map((line) => `${line.label}: ${size(line.points[index])}`).join("\n")}`}/>)}
            </div>
          </>
        : <div className="stats-chart" role="img" aria-label={t("stats.chartLabel", { peak: size(peak) })}>
            {summary.points.map((point) => <div key={point.at} className="stats-bar" title={`${stamp(point.at, summary.step)}: ${size(point.bytes)}, ${files(point.count)}`}>
              <span style={{ height: `${Math.max(point.bytes ? 2 : 0, (point.bytes / peak) * 100)}%` }}/>
            </div>)}
          </div>}
    </div>

    <div className="stats-xaxis">
      {marks.map((index, order) => <span key={index} style={{
        left: `${summary.points.length > 1 ? (index / (summary.points.length - 1)) * 100 : 0}%`,
        transform: order === 0 ? "none" : order === marks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
      }}>{summary.points[index] ? stamp(summary.points[index].at, summary.step) : ""}</span>)}
    </div>
  </div>;
}

function Breakdown({ title, kind, items, chosen, onToggle, colors }: {
  title: string; kind: string; items: StatsSummary["providers"];
  chosen: Set<string>; onToggle: (id: string) => void; colors: Map<string, string>;
}) {
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  return <section className="panel stats-breakdown">
    <h3>{title}</h3>
    {!items.length ? <p className="stats-empty">{t("stats.emptyPeriod")}</p> : <ul>
      {items.map((item) => {
        const id = `${kind}:${item.key}`;
        const color = colors.get(id);
        return <li key={item.key}>
          <button className={`stats-pick${chosen.has(id) ? " chosen" : ""}`} onClick={() => onToggle(id)}
            aria-pressed={chosen.has(id)} title={chosen.has(id) ? t("stats.removeFromChart") : t("stats.addToChart")}>
            <span className="stats-dot" style={color ? { background: color } : undefined}/>
            <span className="stats-name">{item.label}</span>
            <b>{size(item.bytes)}</b>
          </button>
          <div className="stats-track"><span style={{ width: `${total ? (item.bytes / total) * 100 : 0}%`, background: color || undefined }}/></div>
          <small>{files(item.count)} · {total ? Math.round((item.bytes / total) * 100) : 0} %</small>
        </li>;
      })}
    </ul>}
  </section>;
}

export function StatsPanel({ onError }: { onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [hours, setHours] = useState(720);
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.stats(hours)
      .then((data) => { if (alive) setSummary(data); })
      .catch((error) => { if (alive) onError(error); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [hours]);

  const toggle = (id: string) => setChosen((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  // Only a picked series gets a colour, so the shades are not handed out at random by position.
  const { lines, colors } = useMemo(() => {
    const colors = new Map<string, string>();
    if (!summary) return { lines: [], colors };
    const pool = [
      ...summary.byProvider.map((line) => ({ ...line, id: `provider:${line.key}` })),
      ...summary.byAddon.map((line) => ({ ...line, id: `addon:${line.key}` })),
      ...summary.bySource.map((line) => ({ ...line, id: `source:${line.key}`, dashed: line.key === "library" })),
    ].filter((line) => chosen.has(line.id));
    const lines = pool.map((line, index) => {
      const color = COLORS[index % COLORS.length];
      colors.set(line.id, color);
      return { ...line, color };
    });
    return { lines, colors };
  }, [summary, chosen]);

  return <section className="stats-page">
    <div className="stats-head">
      <div>
        <h2>{t("stats.title")}</h2>
        <p>{summary?.since
          ? t("stats.lead", { since: new Date(summary.since).toLocaleDateString(localeTag()) })
          : t("stats.leadEmpty")}</p>
      </div>
      <div className="stats-periods" role="group" aria-label={t("stats.periodGroup")}>
        {PERIODS.map((period) => <button key={period.hours} className={period.hours === hours ? "active" : ""} onClick={() => setHours(period.hours)}>{t(period.key)}</button>)}
      </div>
    </div>

    {!summary ? <p className="stats-empty">{loading ? t("common.loading") : t("stats.loadFailed")}</p> : <>
      <div className="stats-cards">
        <Card title={t("stats.card.hour")} window={summary.hour}/>
        <Card title={t("stats.card.day")} window={summary.day}/>
        <Card title={t("stats.card.week")} window={summary.week}/>
        <Card title={t("stats.card.month")} window={summary.month}/>
        <Card title={t("stats.card.total")} window={summary.total}/>
      </div>

      <section className="panel stats-graph">
        <div className="stats-graph-head">
          <h3>{lines.length ? t("stats.chosenTrend") : t("stats.periodTrend")}</h3>
          {lines.length > 0 && <div className="stats-legend">
            {lines.map((line) => <span key={line.id}><i style={{ background: line.color }}/>{line.label}</span>)}
            <button className="link-button" onClick={() => setChosen(new Set())}>{t("stats.clearSelection")}</button>
          </div>}
        </div>
        {summary.points.some((point) => point.bytes) || lines.length
          ? <Chart summary={summary} lines={lines}/>
          : <p className="stats-empty">{t("stats.noTraffic")}</p>}
      </section>

      <p className="stats-hint">{t("stats.hint")}</p>

      <div className="stats-columns">
        <Breakdown title={t("stats.byProvider")} kind="provider" items={summary.providers} chosen={chosen} onToggle={toggle} colors={colors}/>
        <Breakdown title={t("stats.byAddon")} kind="addon" items={summary.addons} chosen={chosen} onToggle={toggle} colors={colors}/>
        <Breakdown title={t("stats.bySource")} kind="source" items={summary.sources} chosen={chosen} onToggle={toggle} colors={colors}/>
      </div>
    </>}
  </section>;
}
