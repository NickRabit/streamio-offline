import { useEffect, useState } from "react";
import { api } from "./api";
import type { StatsSummary } from "./types";

const size = (value: number) => !value ? "0 B"
  : value >= 1e12 ? `${(value / 1e12).toFixed(2)} TB`
  : value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB`
  : value >= 1e6 ? `${Math.round(value / 1e6)} MB`
  : `${Math.round(value / 1e3)} kB`;

const den = (count: number) => count === 1 ? "1 soubor" : count >= 2 && count <= 4 ? `${count} soubory` : `${count} souborů`;
const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" });

const PERIODS = [
  { days: 7, label: "7 dní" },
  { days: 30, label: "30 dní" },
  { days: 90, label: "90 dní" },
  { days: 365, label: "rok" },
];

function Card({ title, window }: { title: string; window: { bytes: number; count: number } }) {
  return <div className="stats-card">
    <small>{title}</small>
    <strong>{size(window.bytes)}</strong>
    <span>{den(window.count)}</span>
  </div>;
}

/** Sloupce kreslíme poměrem k největšímu dni; prázdné dny zůstávají jako mezery,
 * aby byl v grafu vidět rytmus stahování, ne jen shluk sloupců za sebou. */
function DayChart({ days }: { days: StatsSummary["days"] }) {
  const peak = Math.max(1, ...days.map((day) => day.bytes));
  return <div className="stats-chart-wrap">
    <div className="stats-chart" role="img" aria-label={`Stahování po dnech, nejvíc ${size(peak)} za den`}>
      {days.map((day) => <div key={day.date} className="stats-bar" title={`${shortDate(day.date)}: ${size(day.bytes)}, ${den(day.count)}`}>
        <span style={{ height: `${Math.max(day.bytes ? 2 : 0, (day.bytes / peak) * 100)}%` }}/>
      </div>)}
    </div>
    <div className="stats-axis">
      <span>{days.length ? shortDate(days[0].date) : ""}</span>
      <span className="stats-peak">vrchol {size(peak)}</span>
      <span>{days.length ? shortDate(days[days.length - 1].date) : ""}</span>
    </div>
  </div>;
}

function Breakdown({ title, items, empty }: { title: string; items: StatsSummary["providers"]; empty: string }) {
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  return <section className="panel stats-breakdown">
    <h3>{title}</h3>
    {!items.length ? <p className="stats-empty">{empty}</p> : <ol>
      {items.map((item) => <li key={item.key}>
        <div className="stats-row-head"><span className="stats-name" title={item.label}>{item.label}</span><b>{size(item.bytes)}</b></div>
        <div className="stats-track"><span style={{ width: `${total ? (item.bytes / total) * 100 : 0}%` }}/></div>
        <small>{den(item.count)} · {total ? Math.round((item.bytes / total) * 100) : 0} %</small>
      </li>)}
    </ol>}
  </section>;
}

export function StatsPanel({ onError }: { onError: (error: unknown) => void }) {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.stats(days)
      .then((data) => { if (alive) setSummary(data); })
      .catch((error) => { if (alive) onError(error); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days]);

  return <section className="stats-page">
    <div className="stats-head">
      <div>
        <h2>Statistiky stahování</h2>
        <p>{summary?.since
          ? `Měříme od ${new Date(summary.since).toLocaleDateString("cs-CZ")}.`
          : "Zatím není co měřit — statistiky se plní po dokončení stahování."}</p>
      </div>
      <div className="stats-periods" role="group" aria-label="Období">
        {PERIODS.map((period) => <button key={period.days} className={period.days === days ? "active" : ""} onClick={() => setDays(period.days)}>{period.label}</button>)}
      </div>
    </div>

    {!summary ? <p className="stats-empty">{loading ? "Načítám…" : "Statistiky se nepodařilo načíst."}</p> : <>
      <div className="stats-cards">
        <Card title="Za 24 hodin" window={summary.day}/>
        <Card title="Za 7 dní" window={summary.week}/>
        <Card title="Za 30 dní" window={summary.month}/>
        <Card title="Celkem" window={summary.total}/>
      </div>

      <section className="panel stats-graph">
        <h3>Průběh za zvolené období</h3>
        {summary.days.some((day) => day.bytes) ? <DayChart days={summary.days}/>
          : <p className="stats-empty">V tomhle období se nic nestáhlo.</p>}
      </section>

      <div className="stats-columns">
        <Breakdown title="Podle zdroje" items={summary.providers} empty="Žádná stahování v období."/>
        <Breakdown title="Podle doplňku" items={summary.addons} empty="Žádná stahování v období."/>
      </div>
    </>}
  </section>;
}
