import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronRight, CirclePlay, Download, Film, Library, PackagePlus, Pause, Play, Plus, RefreshCw, Search, Settings, Subtitles, Trash2, X } from "lucide-react";
import { api } from "./api";
import { Player } from "./Player";
import type { Addon, Catalog, Download as DownloadJob, Meta, Stream, Subtitle, Video } from "./types";

type View = "catalog" | "downloads" | "addons" | "settings";
const bytes = (value?: number) => !value ? "—" : value > 1e9 ? `${(value / 1e9).toFixed(1)} GB` : value > 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${Math.round(value / 1e3)} kB`;
const speed = (value: number) => value ? `${bytes(value)}/s` : "—";
const streamLabel = (item: Stream) => item.name || item.title?.split("\n")[0] || item.description?.split("\n")[0] || (item.infoHash ? "Torrent" : "Stream");

export function App() {
  const [view, setView] = useState<View>("catalog"); const [addons, setAddons] = useState<Addon[]>([]); const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [selectedCatalog, setSelectedCatalog] = useState(""); const [search, setSearch] = useState(""); const [items, setItems] = useState<Meta[]>([]); const [selected, setSelected] = useState<Meta | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null); const [streams, setStreams] = useState<Stream[]>([]); const [selectedStream, setSelectedStream] = useState<Stream | null>(null); const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [playerOpen, setPlayerOpen] = useState(false);
  const [concurrentDownloads, setConcurrentDownloads] = useState(1);
  const currentCatalog = catalogs.find((catalog) => `${catalog.addonKey}:${catalog.type}:${catalog.id}` === selectedCatalog) ?? catalogs[0];
  const searchRequired = Boolean(currentCatalog?.extra?.some((extra) => extra.name === "search" && extra.isRequired));
  const videoId = selectedVideo?.id || selected?.id; const videoTitle = selectedVideo ? `${selected?.name} · ${selectedVideo.title || selectedVideo.name || `S${selectedVideo.season}E${selectedVideo.episode}`}` : selected?.name || "Video";
  const notify = (text: string) => { setMessage(text); setTimeout(() => setMessage(""), 3200); };
  const fail = (value: unknown) => { setError(value instanceof Error ? value.message : String(value)); setTimeout(() => setError(""), 6000); };

  const refresh = async () => {
    const [nextAddons, nextCatalogs] = await Promise.all([api.addons(), api.catalogs()]); setAddons(nextAddons); setCatalogs(nextCatalogs);
    if (!selectedCatalog && nextCatalogs[0]) setSelectedCatalog(`${nextCatalogs[0].addonKey}:${nextCatalogs[0].type}:${nextCatalogs[0].id}`);
  };
  const loadDownloads = () => api.downloads().then(setDownloads).catch(fail);
  useEffect(() => { refresh().catch(fail); loadDownloads(); api.settings().then((value) => setConcurrentDownloads(value.concurrentDownloads)).catch(fail); }, []);
  useEffect(() => { if (view !== "downloads") return; loadDownloads(); const timer = setInterval(loadDownloads, 1200); return () => clearInterval(timer); }, [view]);

  const loadCatalog = async (event?: FormEvent) => {
    event?.preventDefault(); if (!currentCatalog) return;
    if (searchRequired && !search.trim()) { setItems([]); setSelected(null); setStreams([]); return; }
    setBusy(true); setSelected(null); setStreams([]);
    try { setItems(await api.catalog(currentCatalog, search)); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  useEffect(() => { if (currentCatalog && items.length === 0) loadCatalog(); }, [currentCatalog?.addonKey, currentCatalog?.id]);
  const fetchSources = async (type: string, id: string, video?: Video) => {
    setSelectedVideo(video ?? null); setSourcesLoaded(false); setBusy(true);
    try { const [nextStreams, nextSubtitles] = await Promise.all([api.streams(type, id), api.subtitles(type, id)]); setStreams(nextStreams); setSelectedStream(nextStreams[0] ?? null); setSubtitles(nextSubtitles); setSourcesLoaded(true); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const openMeta = async (item: Meta) => {
    setSelected(item); setSelectedVideo(null); setStreams([]); setSelectedStream(null); setSubtitles([]); setSourcesLoaded(false);
    const type = item.type || currentCatalog?.type || "movie";
    let detail = item;
    try { detail = { ...item, ...await api.meta(type, item.id) }; setSelected(detail); } catch { /* catalog item is still useful */ }
    if (type !== "series" && !detail.videos?.length) await fetchSources(type, item.id);
  };
  const loadSources = async (video?: Video) => {
    if (!selected) return; await fetchSources(selected.type || currentCatalog?.type || "movie", video?.id || selected.id, video);
  };
  const enqueue = async () => { if (!selectedStream) return; try { await api.download(videoTitle, selectedStream); notify("Přidáno do stahovací fronty."); } catch (e) { fail(e); } };

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><CirclePlay/></div><div><small>DOMÁCÍ MEDIATÉKA</small><h1>Stremio <span>Offline</span></h1></div></div><div className="online"><i/> Docker server online</div></header>
    <aside className="sidebar"><nav>
      <Nav icon={<Library/>} label="Katalog" active={view === "catalog"} onClick={() => setView("catalog")}/>
      <Nav icon={<Download/>} label="Stahování" active={view === "downloads"} badge={downloads.filter((d) => d.status === "downloading" || d.status === "queued").length} onClick={() => setView("downloads")}/>
      <Nav icon={<PackagePlus/>} label="Doplňky" active={view === "addons"} badge={addons.length} onClick={() => setView("addons")}/>
      <Nav icon={<Settings/>} label="Nastavení" active={view === "settings"} onClick={() => setView("settings")}/>
    </nav><div className="addon-status"><small>AKTIVNÍ DOPLŇKY</small><strong>{addons.filter((a) => a.enabled).length}</strong><span>katalogy a zdroje</span></div></aside>
    <main>
      {view === "catalog" && <section><Heading eyebrow="KATALOG" title="Co chcete sledovat?"/>
        {!catalogs.length ? <Onboarding onOpen={() => setView("addons")}/> : <>
          <form className="searchbar" onSubmit={loadCatalog}><select value={selectedCatalog} onChange={(e) => { setSelectedCatalog(e.target.value); setItems([]); }}>
            {catalogs.map((catalog) => <option key={`${catalog.addonKey}:${catalog.type}:${catalog.id}`} value={`${catalog.addonKey}:${catalog.type}:${catalog.id}`}>{catalog.addonName} · {catalog.name || catalog.id} ({catalog.type === "series" ? "seriály" : catalog.type})</option>)}
          </select><div className="search-input"><Search/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Hledat v katalogu…"/></div><button className="primary" disabled={busy}>Vyhledat</button></form>
          <div className="catalog-layout"><section className="panel result-panel"><div className="panel-head"><h3>Výsledky</h3><span>{items.length} položek</span></div>
            <div className="poster-grid">{items.map((item) => <button key={`${item.type}:${item.id}`} className={`poster-card ${selected?.id === item.id ? "selected" : ""}`} onClick={() => openMeta(item)}>{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <div className="poster-fallback"><Film/></div>}<strong>{item.name}</strong><small>{item.releaseInfo || item.year || item.type}</small></button>)}</div>
            {!items.length && !busy && <Empty icon={<Search/>} title={searchRequired && !search.trim() ? "Zadejte hledaný název" : "Katalog je prázdný"} text={searchRequired && !search.trim() ? "Tento katalog vrací výsledky až po zadání hledaného výrazu." : "Zkuste vyhledávání nebo jiný katalog."}/>} {busy && <div className="loading">Načítám…</div>}
          </section><section className="panel detail-panel">{selected ? <>
            <div className="hero" style={selected.background ? { backgroundImage: `linear-gradient(90deg,#121721 25%,transparent),url(${selected.background})` } : undefined}><div className="detail-copy"><span className="pill">{selected.type === "series" ? "Seriál" : "Film"}</span><h2>{selected.name}</h2><p className="meta-line">{[selected.releaseInfo || selected.year, ...(selected.genres || []).slice(0, 3)].filter(Boolean).join(" · ")}</p><p>{selected.description || "Bez popisu."}</p></div></div>
            {selected.videos?.length ? <div className="episodes"><div className="subhead"><h3>Epizody</h3><span>{selected.videos.length}</span></div><div className="episode-list">{selected.videos.map((video, index) => <button key={video.id || index} className={selectedVideo?.id === video.id ? "selected" : ""} onClick={() => loadSources(video)}><b>{video.season != null ? `${String(video.season).padStart(2,"0")}×${String(video.episode || 0).padStart(2,"0")}` : index + 1}</b><span>{video.title || video.name || "Epizoda"}</span><ChevronRight/></button>)}</div></div> : !sourcesLoaded && <button className="primary wide" onClick={() => loadSources()} disabled={busy}>Načíst zdroje</button>}
            {sourcesLoaded && <div className="sources"><div className="subhead"><h3>Zdroje</h3><span>{streams.length}</span></div><div className="stream-list">{streams.map((stream, index) => <button key={index} className={selectedStream === stream ? "selected" : ""} onClick={() => setSelectedStream(stream)}><i>{stream.url ? "HTTP" : stream.infoHash ? "P2P" : "EXT"}</i><span><strong>{streamLabel(stream)}</strong><small>{stream.addonName} {stream.behaviorHints?.videoSize ? `· ${bytes(stream.behaviorHints.videoSize)}` : ""}</small></span>{selectedStream === stream && <Check/>}</button>)}</div>
              {!streams.length && <div className="no-sources">Žádný aktivní zdrojový doplněk pro tento titul nevrátil stream.</div>}
              <div className="source-info"><Subtitles/> {subtitles.length + (selectedStream?.subtitles?.length || 0)} titulků</div><div className="actions"><button className="primary" disabled={!selectedStream?.url} onClick={() => setPlayerOpen(true)}><CirclePlay/> Přehrát</button><button disabled={!selectedStream?.url} onClick={enqueue}><Download/> Stáhnout</button>{selectedStream?.externalUrl && <a className="button" href={selectedStream.externalUrl} target="_blank">Otevřít externě</a>}</div>
              {selectedStream?.infoHash && !selectedStream.url && <p className="notice">Tento doplněk vrátil nezpracovaný torrent. Přímé Real-Debrid rozlišení přidáme v další etapě; RD doplněk obvykle vrací rovnou HTTPS adresu.</p>}
            </div>}
          </> : <Empty icon={<Film/>} title="Vyberte titul" text="Zobrazí se podrobnosti, epizody a zdroje ze všech aktivních doplňků."/>}</section></div>
        </>}
      </section>}
      {view === "addons" && <Addons addons={addons} onChanged={refresh} onNotify={notify} onError={fail}/>} 
      {view === "downloads" && <Downloads jobs={downloads} refresh={loadDownloads} onError={fail}/>}
      {view === "settings" && <section><Heading eyebrow="NASTAVENÍ" title="Docker a úložiště"/><div className="panel settings-card"><h3>Adresář pro stažené soubory</h3><code>/downloads</code><p>Namapujte tento adresář v <code>compose.yml</code> na sdílenou složku svého NAS.</p><label className="setting-row"><span><strong>Souběžná stahování</strong><small>Na slabším NAS doporučujeme 1–2 soubory současně.</small></span><select value={concurrentDownloads} onChange={async (event) => { const value = Number(event.target.value); setConcurrentDownloads(value); try { await api.updateSettings(value); notify("Nastavení fronty uloženo."); } catch (e) { fail(e); } }}>{[1,2,3,4,5,6,7,8].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><div className="log-actions"><a className="button" href="/api/logs" download="stremio-offline.log">Stáhnout log</a><button className="button" onClick={async () => { try { await navigator.clipboard.writeText(await api.logs()); notify("Log zkopírován do schránky."); } catch (e) { fail(e); } }}>Kopírovat log</button></div><small>Log obsahuje stav přenosů, rychlost a HTTP chyby; URL streamů ani přístupové tokeny se nezapisují.</small></div></section>}
    </main>
    <Player open={playerOpen} title={videoTitle} stream={selectedStream} subtitles={subtitles} onClose={() => setPlayerOpen(false)}/>
    {(message || error) && <div className={`toast ${error ? "error" : ""}`}>{error || message}<button onClick={() => {setError("");setMessage("");}}><X/></button></div>}
  </div>;
}

function Nav({ icon, label, active, badge, onClick }: { icon: React.ReactNode; label: string; active: boolean; badge?: number; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}>{icon}<span>{label}</span>{badge != null && <b>{badge}</b>}</button>; }
function Heading({ eyebrow, title }: { eyebrow: string; title: string }) { return <div className="heading"><small>{eyebrow}</small><h2>{title}</h2></div>; }
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty"><i>{icon}</i><h3>{title}</h3><p>{text}</p></div>; }
function Onboarding({ onOpen }: { onOpen: () => void }) { return <div className="panel onboarding"><i><PackagePlus/></i><h2>Přidejte první Stremio doplněk</h2><p>Aplikace potřebuje alespoň jeden katalogový manifest. Zdrojové manifesty s Real-Debrid můžete přidat samostatně.</p><button className="primary" onClick={onOpen}><Plus/> Přidat manifest</button></div>; }

function Addons({ addons, onChanged, onNotify, onError }: { addons: Addon[]; onChanged: () => Promise<void>; onNotify: (s:string)=>void; onError:(e:unknown)=>void }) {
  const [url, setUrl] = useState(""); const [role, setRole] = useState("both"); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { await api.addAddon(url, role); setUrl(""); await onChanged(); onNotify("Manifest byl přidán."); } catch (err) { onError(err); } finally { setBusy(false); } };
  return <section><Heading eyebrow="DOPLŇKY" title="Knihovny a zdroje"/><p className="lead">Vložte adresu končící na <code>manifest.json</code>. Personalizovaná URL může obsahovat citlivý token; v rozhraní ji po uložení skryjeme.</p>
    <form className="panel addon-form" onSubmit={submit}><label><span>URL manifestu</span><input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://…/manifest.json" required/></label><label><span>Úloha</span><select value={role} onChange={(e)=>setRole(e.target.value)}><option value="both">Automaticky / obojí</option><option value="catalog">Pouze knihovna</option><option value="source">Pouze zdroje</option></select></label><button className="primary" disabled={busy}><Plus/> Přidat</button></form>
    <div className="addon-grid">{addons.map((addon) => <article className="panel addon-card" key={addon.key}>{addon.manifest.logo ? <img src={addon.manifest.logo} alt=""/> : <div className="addon-logo"><PackagePlus/></div>}<div><div className="addon-title"><h3>{addon.manifest.name}</h3>{addon.manifest.behaviorHints?.p2p && <span className="p2p">P2P</span>}</div><p>{addon.manifest.description || addon.displayUrl}</p><small>{addon.manifest.version} · {addon.role === "catalog" ? "knihovna" : addon.role === "source" ? "zdroje" : "knihovna i zdroje"}</small></div><div className="addon-actions"><label className="switch"><input type="checkbox" checked={addon.enabled} onChange={async (e)=>{await api.toggleAddon(addon.key,e.target.checked);await onChanged();}}/><span/></label><button className="danger icon-button" title="Odstranit" onClick={async()=>{await api.deleteAddon(addon.key);await onChanged();}}><Trash2/></button></div></article>)}</div>
  </section>;
}

function Downloads({ jobs, refresh, onError }: { jobs: DownloadJob[]; refresh: () => Promise<void>; onError: (e: unknown) => void }) {
  const active = jobs.filter((job) => job.status === "downloading"); const totalSpeed = active.reduce((sum, job) => sum + job.speed, 0); const eta = (job: DownloadJob) => job.speed > 0 && job.total ? fmtEta((job.total - job.received) / job.speed) : "—";
  const action = async (operation: () => Promise<void>) => { try { await operation(); await refresh(); } catch (error) { onError(error); } };
  return <section><div className="download-title"><Heading eyebrow="STAHOVÁNÍ" title="Fronta"/><button disabled={!jobs.some((job) => job.status === "completed")} onClick={() => action(api.clearCompleted)}><Trash2/> Vyčistit dokončené</button></div><div className="summary"><div><b>{jobs.length}</b><span>položek</span></div><div><b>{active.length}</b><span>probíhá</span></div><div><b>{speed(totalSpeed)}</b><span>celková rychlost</span></div></div><div className="panel downloads"><div className="download-head"><span>Název</span><span>Stav</span><span>Průběh</span><span>Rychlost / zbývá</span><span>Akce</span></div>{jobs.map((job)=><div className="download-row" key={job.id}><div><strong>{job.title}</strong><small>{job.target}{job.error ? ` · ${job.error}`:""}</small></div><span className={`job-status ${job.status}`}>{statusLabel(job.status)}</span><div><span>{bytes(job.received)} / {bytes(job.total)}</span><div className="progress"><i style={{width:`${job.total ? Math.min(100, job.received/job.total*100):0}%`}}/></div></div><span>{speed(job.speed)}<small>{eta(job)}</small></span><div className="queue-actions"><button title="Nahoru" disabled={job.order === 0 || job.status === "downloading"} onClick={() => action(() => api.moveDownload(job.id, -1))}><ArrowUp/></button><button title="Dolů" disabled={job.order === jobs.length - 1 || job.status === "downloading"} onClick={() => action(() => api.moveDownload(job.id, 1))}><ArrowDown/></button>{job.status === "downloading" || job.status === "queued" ? <button title="Pozastavit" onClick={() => action(() => api.downloadAction(job.id,"pause"))}><Pause/></button> : job.status === "paused" ? <button title="Pokračovat" onClick={() => action(() => api.downloadAction(job.id,"resume"))}><Play/></button> : job.status === "failed" ? <button title="Zkusit znovu" onClick={() => action(() => api.downloadAction(job.id,"retry"))}><RefreshCw/></button> : null}<button className="danger" title="Odstranit z fronty" onClick={() => action(() => api.removeDownload(job.id))}><Trash2/></button></div></div>)}{!jobs.length && <Empty icon={<Download/>} title="Fronta je prázdná" text="Vyberte přímý HTTP stream a použijte tlačítko Stáhnout."/>}</div></section>;
}
const fmtEta = (seconds: number) => seconds < 60 ? `${Math.ceil(seconds)} s` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min`;
const statusLabel = (status: DownloadJob["status"]) => ({ queued: "Ve frontě", downloading: "Stahuji", paused: "Pozastaveno", completed: "Dokončeno", failed: "Chyba" })[status];
