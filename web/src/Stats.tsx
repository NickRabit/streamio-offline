import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { StatsSeries, StatsSummary } from "./types";

const size = (value: number) => !value ? "0 B"
  : value >= 1e12 ? `${(value / 1e12).toFixed(2)} TB`
  : value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB`
  : value >= 1e6 ? `${Math.round(value / 1e6)} MB`
  : `${Math.round(value / 1e3)} kB`;

const files = (count: number) => count === 1 ? "1 soubor" : count >= 2 && count <= 4 ? `${count} soubory` : `${count} souborů`;

const PERIODS = [
  { hours: 1, label: "hodina" },
  { hours: 24, label: "24 hodin" },
  { hours: 168, label: "7 dní" },
  { hours: 720, label: "30 dní" },
  { hours: 2160, label: "90 dní" },
  { hours: 8760, label: "rok" },
];

/** Barvy vybraných řad. Odstíny jsou ověřené proti tmavému podkladu panelu:
 * drží pásmo světlosti, sytost i odstup pro barvosleposti, takže sousední
 * linky nesplynou. Víc než osm zdrojů naráz stejně rozlišit nejde. */
const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** Osa Y má pět dílků; hodnoty se odvozují od vrcholu, ať je vidět měřítko. */
const TICKS = [1, 0.75, 0.5, 0.25, 0];

/** Na osu X se vejde jen pár popisků, jinak se přes sebe přeloží. */
const xTicks = (count: number) => {
  const wanted = Math.min(6, count);
  if (wanted < 2) return [0];
  return Array.from({ length: wanted }, (_, index) => Math.round((index * (count - 1)) / (wanted - 1)));
};

const stamp = (at: string, step: StatsSummary["step"]) => {
  const date = new Date(at);
  if (step === "day") return date.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" });
  if (step === "hour") return date.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
};

function Card({ title, window }: { title: string; window: { bytes: number; count: number } }) {
  return <div className="stats-card">
    <small>{title}</small>
    <strong>{size(window.bytes)}</strong>
    <span>{files(window.count)}</span>
  </div>;
}

/** Bez výběru kreslíme celkový objem sloupci, s výběrem každou řadu vlastní linkou. */
function Chart({ summary, lines }: { summary: StatsSummary; lines: Array<StatsSeries & { color: string }> }) {
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
            <svg className="stats-lines" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Průběh vybraných zdrojů">
              {lines.map((line) => <polyline key={line.key} fill="none" stroke={line.color} strokeWidth={2} vectorEffect="non-scaling-stroke"
                strokeLinejoin="round" strokeLinecap="round"
                points={line.points.map((value, index) => `${index * stride},${height - (value / peak) * (height - 6)}`).join(" ")}/>)}
            </svg>
            {/* Průhledné sloupce nad grafem nesou bublinu s hodnotami všech vybraných řad. */}
            <div className="stats-hover">
              {summary.points.map((point, index) => <div key={point.at}
                title={`${stamp(point.at, summary.step)}\n${lines.map((line) => `${line.label}: ${size(line.points[index])}`).join("\n")}`}/>)}
            </div>
          </>
        : <div className="stats-chart" role="img" aria-label={`Stahování po obdobích, nejvíc ${size(peak)}`}>
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
    {!items.length ? <p className="stats-empty">Žádná stahování v období.</p> : <ul>
      {items.map((item) => {
        const id = `${kind}:${item.key}`;
        const color = colors.get(id);
        return <li key={item.key}>
          <button className={`stats-pick${chosen.has(id) ? " chosen" : ""}`} onClick={() => onToggle(id)}
            aria-pressed={chosen.has(id)} title={chosen.has(id) ? "Odebrat z grafu" : "Přidat do grafu"}>
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

  // Barvu dostane jen vybraná řada, ať se odstíny nepřidělují nazdařbůh podle pořadí.
  const { lines, colors } = useMemo(() => {
    const colors = new Map<string, string>();
    if (!summary) return { lines: [], colors };
    const pool = [
      ...summary.byProvider.map((line) => ({ ...line, id: `provider:${line.key}` })),
      ...summary.byAddon.map((line) => ({ ...line, id: `addon:${line.key}` })),
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
        <h2>Statistiky stahování</h2>
        <p>{summary?.since
          ? `Měříme od ${new Date(summary.since).toLocaleDateString("cs-CZ")}.`
          : "Zatím není co měřit — přehled se plní po dokončení stahování."}</p>
      </div>
      <div className="stats-periods" role="group" aria-label="Období">
        {PERIODS.map((period) => <button key={period.hours} className={period.hours === hours ? "active" : ""} onClick={() => setHours(period.hours)}>{period.label}</button>)}
      </div>
    </div>

    {!summary ? <p className="stats-empty">{loading ? "Načítám…" : "Statistiky se nepodařilo načíst."}</p> : <>
      <div className="stats-cards">
        <Card title="Za hodinu" window={summary.hour}/>
        <Card title="Za 24 hodin" window={summary.day}/>
        <Card title="Za 7 dní" window={summary.week}/>
        <Card title="Za 30 dní" window={summary.month}/>
        <Card title="Celkem" window={summary.total}/>
      </div>

      <section className="panel stats-graph">
        <div className="stats-graph-head">
          <h3>{lines.length ? "Průběh vybraných zdrojů" : "Průběh za zvolené období"}</h3>
          {lines.length > 0 && <div className="stats-legend">
            {lines.map((line) => <span key={line.id}><i style={{ background: line.color }}/>{line.label}</span>)}
            <button className="link-button" onClick={() => setChosen(new Set())}>zrušit výběr</button>
          </div>}
        </div>
        {summary.points.some((point) => point.bytes) || lines.length
          ? <Chart summary={summary} lines={lines}/>
          : <p className="stats-empty">V tomhle období se nic nestáhlo.</p>}
      </section>

      <p className="stats-hint">Kliknutím na zdroj nebo doplněk přidáte jeho vlastní linii do grafu; vybrat jich jde víc naráz.</p>

      <div className="stats-columns">
        <Breakdown title="Podle zdroje" kind="provider" items={summary.providers} chosen={chosen} onToggle={toggle} colors={colors}/>
        <Breakdown title="Podle doplňku" kind="addon" items={summary.addons} chosen={chosen} onToggle={toggle} colors={colors}/>
      </div>
    </>}
  </section>;
}
