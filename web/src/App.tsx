import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CirclePlay, Download, FileText, Film, FolderCog, HardDrive, Library, PackagePlus, Pause, Play, Plus, RefreshCw, Search, Settings, Subtitles, Trash2, X } from "lucide-react";
import { api } from "./api";
import { Player } from "./Player";
import { guessLanguages, label } from "./languages";
import type { Addon, AddonDownloadSettings, Catalog, Download as DownloadJob, Inspection, Meta, Settings as AppSettings, Stream, Subtitle, Video } from "./types";

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
  const [settings, setSettings] = useState<AppSettings>({ concurrentDownloads: 1, audioLanguage: "cs", subtitleLanguage: "cs", mergeByName: true });
  const [languages, setLanguages] = useState<Array<{ code: string; name: string }>>([]);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [submittedQuery, setSubmittedQuery] = useState(""); const [searchAddon, setSearchAddon] = useState(""); const [searchable, setSearchable] = useState<Array<{ addonKey: string; addonName: string }>>([]); const [typeFilter, setTypeFilter] = useState(""); const [genre, setGenre] = useState(""); const [sort, setSort] = useState("default");
  const [skip, setSkip] = useState(0); const [cursor, setCursor] = useState(""); const [hasMore, setHasMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false); const [sourceCount, setSourceCount] = useState(0);
  const loadingRef = useRef(false); const requestRef = useRef(0); const itemsRef = useRef<Meta[]>([]); const gridRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => { refresh().catch(fail); loadDownloads(); api.settings().then(setSettings).catch(fail); api.languages().then(setLanguages).catch(() => undefined); }, []);
  // Nabídka doplňků, ve kterých má smysl hledat, se mění s jejich zapínáním.
  useEffect(() => { api.searchable().then(setSearchable).catch(() => undefined); }, [addons]);
  // Přesné jazyky zná až rozbor souboru, tak ho uděláme pro vybraný stream.
  useEffect(() => {
    setInspection(null);
    if (!selectedStream?.url) return;
    let stale = false;
    api.inspect(selectedStream).then((value) => { if (!stale) setInspection(value); }).catch(() => undefined);
    return () => { stale = true; };
  }, [selectedStream]);
  const saveSettings = async (patch: Partial<AppSettings>) => {
    setSettings((current: AppSettings) => ({ ...current, ...patch }));
    try { setSettings(await api.updateSettings(patch)); notify("Nastavení uloženo."); } catch (e) { fail(e); }
  };
  // Odznak u Stahování musí sedět i mimo tuto záložku, jen se tam nemusí obnovovat tak často.
  useEffect(() => { loadDownloads(); const timer = setInterval(loadDownloads, view === "downloads" ? 1200 : 5000); return () => clearInterval(timer); }, [view]);

  const genreOptions = currentCatalog?.extra?.find((extra) => extra.name === "genre")?.options ?? [];

  /** Stejné položky se můžou vrátit z víc doplňků i z víc stránek. */
  const merge = (previous: Meta[], incoming: Meta[]) => {
    const seen = new Set(previous.map((item) => `${item.type}:${item.id}`));
    return [...previous, ...incoming.filter((item) => !seen.has(`${item.type}:${item.id}`))];
  };

  const loadPage = async (reset: boolean) => {
    if (!submittedQuery && !currentCatalog) return;
    // Donačítání se smí zahodit, ale nové zadání ne — to musí předchozí běh přebít.
    if (!reset && loadingRef.current) return;
    const request = reset ? ++requestRef.current : requestRef.current;
    const stale = () => request !== requestRef.current;
    loadingRef.current = true;
    const from = reset ? 0 : skip;
    if (reset) { setBusy(true); setSelected(null); setStreams([]); } else setLoadingMore(true);
    try {
      if (submittedQuery) {
        const result = await api.search(submittedQuery, typeFilter, reset ? "" : cursor, searchAddon);
        if (stale()) return;
        const next = reset ? result.items : merge(itemsRef.current, result.items);
        // Doplněk může vracet pořád totéž; bez téhle pojistky by se donačítalo donekonečna.
        const gainedNothing = !reset && next.length === itemsRef.current.length;
        itemsRef.current = next; setItems(next);
        setSourceCount(result.sources); setCursor(result.cursor); setHasMore(result.hasMore && !gainedNothing);
      } else {
        const metas = await api.catalog(currentCatalog!, "", from, genre);
        if (stale()) return;
        const next = reset ? metas : merge(itemsRef.current, metas);
        const gainedNothing = !reset && next.length === itemsRef.current.length;
        itemsRef.current = next; setItems(next);
        setSkip(from + metas.length); setHasMore(metas.length > 0 && !gainedNothing);
      }
    } catch (e) { if (!stale()) { fail(e); setHasMore(false); } }
    finally { if (!stale()) { loadingRef.current = false; setBusy(false); setLoadingMore(false); } }
  };

  const submitSearch = (event?: FormEvent) => { event?.preventDefault(); setSubmittedQuery(search.trim()); };
  // Změna katalogu, dotazu nebo filtru začíná od první stránky.
  useEffect(() => { itemsRef.current = []; setItems([]); setSkip(0); setCursor(""); setHasMore(false); setSourceCount(0); void loadPage(true); },
    [submittedQuery, searchAddon, typeFilter, genre, currentCatalog?.addonKey, currentCatalog?.id]);

  // Mřížka je vlastní posuvník. Obyčejný posluchač scrollu funguje i tam,
  // kde IntersectionObserver mlčí (skrytý dokument, úsporné režimy).
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !hasMore) return;
    const onScroll = () => { if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) void loadPage(false); };
    grid.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => grid.removeEventListener("scroll", onScroll);
  }, [hasMore, skip, cursor, submittedQuery, searchAddon, typeFilter, genre, currentCatalog?.addonKey, currentCatalog?.id]);

  /** Tentýž film vede každý doplněk pod svým ID. Slučujeme podle názvu a roku a držíme se
   *  položky s IMDb ID, protože podle něj hledají zdrojové doplňky streamy. */
  const groupByName = (list: Meta[]) => {
    const groups = new Map<string, Meta>();
    for (const item of list) {
      const year = String(item.releaseInfo ?? item.year ?? "").slice(0, 4);
      const key = `${item.type}|${item.name.trim().toLowerCase()}|${year}`;
      const sources = item.sources ?? [item.addonName].filter(Boolean) as string[];
      const existing = groups.get(key);
      if (!existing) { groups.set(key, { ...item, sources: [...sources] }); continue; }
      const merged = existing.sources ?? [];
      for (const source of sources) if (!merged.includes(source)) merged.push(source);
      const preferIncoming = !String(existing.id).startsWith("tt") && String(item.id).startsWith("tt");
      const winner = preferIncoming ? { ...item } : existing;
      winner.sources = merged;
      winner.poster = existing.poster || item.poster;
      winner.description = existing.description || item.description;
      groups.set(key, winner);
    }
    return [...groups.values()];
  };

  const visibleItems = useMemo(() => {
    const year = (item: Meta) => Number(String(item.releaseInfo ?? item.year ?? "").slice(0, 4)) || 0;
    const list = settings.mergeByName ? groupByName(items) : [...items];
    if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "cs"));
    else if (sort === "year") list.sort((a, b) => year(b) - year(a));
    return list;
  }, [items, sort, settings.mergeByName]);
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
  const enqueue = async () => {
    if (!selectedStream) return;
    // Server podle toho poskládá cestu; bez těchto údajů by z epizody byl placatý soubor.
    const media = selectedVideo
      ? { kind: "episode", title: selected?.name, season: selectedVideo.season, episode: selectedVideo.episode, episodeTitle: selectedVideo.title || selectedVideo.name }
      : { kind: "movie", title: selected?.name };
    try { await api.download(videoTitle, selectedStream, media); notify("Přidáno do stahovací fronty."); await loadDownloads(); } catch (e) { fail(e); }
  };

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
          <form className="searchbar" onSubmit={submitSearch}>
            <div className="search-input"><Search/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Hledat ve všech doplňcích naráz…"/></div>
            <label className="scope-select"><span>v</span><select aria-label="Kde hledat" value={searchAddon} onChange={(e) => setSearchAddon(e.target.value)}>
              <option value="">všech doplňcích</option>
              {[...new Map(searchable.map((item) => [item.addonKey, item.addonName])).entries()].map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select></label>
            <button className="primary" disabled={busy}><Search/> Vyhledat</button>
            {submittedQuery && <button type="button" onClick={() => { setSearch(""); setSubmittedQuery(""); }}><X/> Zrušit</button>}
          </form>
          <div className="filterbar">
            {submittedQuery
              ? <>
                  <span className="scope-badge">Prohledáno {sourceCount} {sourceCount === 1 ? "katalog" : sourceCount >= 2 && sourceCount <= 4 ? "katalogy" : "katalogů"} {searchAddon ? `v doplňku ${searchable.find((item) => item.addonKey === searchAddon)?.addonName ?? ""}` : "ve všech doplňcích"}</span>
                  <label><span>Typ</span><select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}><option value="">Vše</option><option value="movie">Filmy</option><option value="series">Seriály</option></select></label>
                </>
              : <>
                  <label><span>Procházet katalog</span><select className="catalog-select" value={selectedCatalog} onChange={(e) => setSelectedCatalog(e.target.value)}>
                    {catalogs.map((catalog) => <option key={`${catalog.addonKey}:${catalog.type}:${catalog.id}`} value={`${catalog.addonKey}:${catalog.type}:${catalog.id}`}>{catalog.addonName} · {catalog.name || catalog.id} ({catalog.type === "series" ? "seriály" : catalog.type})</option>)}
                  </select></label>
                  {genreOptions.length > 0 && <label><span>Žánr</span><select value={genre} onChange={(e) => setGenre(e.target.value)}><option value="">Všechny</option>{genreOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>}
                </>}
            <label><span>Řazení</span><select value={sort} onChange={(e) => setSort(e.target.value)}><option value="default">Podle doplňku</option><option value="name">Název A–Ž</option><option value="year">Rok sestupně</option></select></label>
            {sort !== "default" && <small className="filter-note">Řadí se jen už načtené položky.</small>}
          </div>
          <div className="catalog-layout"><section className="panel result-panel"><div className="panel-head"><h3>{submittedQuery ? `Hledání: ${submittedQuery}` : "Výsledky"}</h3><span>{visibleItems.length} položek{hasMore ? "+" : ""}</span></div>
            <div className="poster-grid" ref={gridRef}>
              {visibleItems.map((item) => <button key={`${item.type}:${item.id}`} className={`poster-card ${selected?.id === item.id ? "selected" : ""}`} onClick={() => openMeta(item)}>{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <div className="poster-fallback"><Film/></div>}<strong>{item.name}</strong><small>{[item.releaseInfo || item.year, submittedQuery ? (item.sources ?? [item.addonName]).filter(Boolean).join(", ") : null].filter(Boolean).join(" · ") || item.type}</small></button>)}
              {hasMore && <div className="load-more">{loadingMore ? <span>Načítám další…</span> : <button onClick={() => void loadPage(false)}>Načíst další</button>}</div>}
            </div>
            {!items.length && !busy && <Empty icon={<Search/>}
              title={submittedQuery ? "Nic se nenašlo" : searchRequired ? "Zadejte hledaný název" : "Katalog je prázdný"}
              text={submittedQuery ? `Žádný z ${sourceCount} prohledávaných katalogů nevrátil výsledek. Zkuste jiný výraz.` : searchRequired ? "Tento katalog vrací výsledky až po zadání hledaného výrazu." : "Zkuste vyhledávání nebo jiný katalog."}/>}
            {busy && <div className="loading">Načítám…</div>}
          </section><section className="panel detail-panel">{selected ? <>
            <div className="hero" style={selected.background ? { backgroundImage: `linear-gradient(90deg,#121721 25%,transparent),url(${selected.background})` } : undefined}><div className="detail-copy"><span className="pill">{selected.type === "series" ? "Seriál" : "Film"}</span><h2>{selected.name}</h2><p className="meta-line">{[selected.releaseInfo || selected.year, ...(selected.genres || []).slice(0, 3)].filter(Boolean).join(" · ")}</p><p>{selected.description || "Bez popisu."}</p></div></div>
            {selected.videos?.length ? <div className="episodes"><div className="subhead"><h3>Epizody</h3><span>{selected.videos.length}</span></div><div className="episode-list">{selected.videos.map((video, index) => <button key={video.id || index} className={selectedVideo?.id === video.id ? "selected" : ""} onClick={() => loadSources(video)}><b>{video.season != null ? `${String(video.season).padStart(2,"0")}×${String(video.episode || 0).padStart(2,"0")}` : index + 1}</b><span>{video.title || video.name || "Epizoda"}</span><ChevronRight/></button>)}</div></div> : !sourcesLoaded && <button className="primary wide" onClick={() => loadSources()} disabled={busy}>Načíst zdroje</button>}
            {sourcesLoaded && <div className="sources"><div className="subhead"><h3>Zdroje</h3><span>{streams.length}</span></div><div className="stream-list">{streams.map((stream, index) => <button key={index} className={selectedStream === stream ? "selected" : ""} onClick={() => setSelectedStream(stream)}><i>{stream.url ? "HTTP" : stream.infoHash ? "P2P" : "EXT"}</i><span><strong>{streamLabel(stream)}</strong><small>{stream.addonName} {stream.behaviorHints?.videoSize ? `· ${bytes(stream.behaviorHints.videoSize)}` : ""} {guessLanguages([stream.name, stream.title, stream.description, stream.behaviorHints?.filename].filter(Boolean).join(" ")).map((code) => <em className="lang-badge" key={code} title="Odhad z názvu od doplňku, nemusí odpovídat souboru">{label(code)}</em>)}</small></span>{selectedStream === stream && <Check/>}</button>)}</div>
              {!streams.length && <div className="no-sources">Žádný aktivní zdrojový doplněk pro tento titul nevrátil stream.</div>}
              <div className="source-info"><Subtitles/> {subtitles.length + (selectedStream?.subtitles?.length || 0)} titulků z doplňků
                {inspection && <> · <b>zvuk v souboru</b> {inspection.audioTracks.length ? inspection.audioTracks.map((track, index) => <em className="lang-badge" key={index}>{label(track.language)}</em>) : "—"}
                · <b>titulky v souboru</b> {inspection.subtitleTracks.length ? inspection.subtitleTracks.map((track, index) => <em className="lang-badge" key={index}>{label(track.language)}</em>) : "—"}</>}
                {selectedStream?.url && !inspection && <> · zjišťuji stopy…</>}</div><div className="actions"><button className="primary" disabled={!selectedStream?.url} onClick={() => setPlayerOpen(true)}><CirclePlay/> Přehrát</button><button disabled={!selectedStream?.url} onClick={enqueue}><Download/> Stáhnout</button>{selectedStream?.externalUrl && <a className="button" href={selectedStream.externalUrl} target="_blank">Otevřít externě</a>}</div>
              {selectedStream?.infoHash && !selectedStream.url && <p className="notice">Tento doplněk vrátil nezpracovaný torrent. Přímé Real-Debrid rozlišení přidáme v další etapě; RD doplněk obvykle vrací rovnou HTTPS adresu.</p>}
            </div>}
          </> : <Empty icon={<Film/>} title="Vyberte titul" text="Zobrazí se podrobnosti, epizody a zdroje ze všech aktivních doplňků."/>}</section></div>
        </>}
      </section>}
      {view === "addons" && <Addons addons={addons} onChanged={refresh} onNotify={notify} onError={fail}/>} 
      {view === "downloads" && <Downloads jobs={downloads} refresh={loadDownloads} onError={fail}/>}
      {view === "settings" && <SettingsPage settings={settings} languages={languages} onSave={saveSettings} onNotify={notify} onError={fail}/>}
    </main>
    <Player open={playerOpen} title={videoTitle} stream={selectedStream} subtitles={subtitles} subtitleLanguage={settings.subtitleLanguage} onClose={() => setPlayerOpen(false)}/>
    {(message || error) && <div className={`toast ${error ? "error" : ""}`}>{error || message}<button onClick={() => {setError("");setMessage("");}}><X/></button></div>}
  </div>;
}

function Nav({ icon, label, active, badge, onClick }: { icon: React.ReactNode; label: string; active: boolean; badge?: number; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}>{icon}<span>{label}</span>{badge != null && <b>{badge}</b>}</button>; }
function Heading({ eyebrow, title }: { eyebrow: string; title: string }) { return <div className="heading"><small>{eyebrow}</small><h2>{title}</h2></div>; }
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty"><i>{icon}</i><h3>{title}</h3><p>{text}</p></div>; }
function Onboarding({ onOpen }: { onOpen: () => void }) { return <div className="panel onboarding"><i><PackagePlus/></i><h2>Přidejte první Stremio doplněk</h2><p>Aplikace potřebuje alespoň jeden katalogový manifest. Zdrojové manifesty s Real-Debrid můžete přidat samostatně.</p><button className="primary" onClick={onOpen}><Plus/> Přidat manifest</button></div>; }

function SettingsPage({ settings, languages, onSave, onNotify, onError }: { settings: AppSettings; languages: Array<{ code: string; name: string }>; onSave: (patch: Partial<AppSettings>) => Promise<void>; onNotify: (message: string) => void; onError: (error: unknown) => void }) {
  const languageOptions = languages.map((item) => <option key={item.code} value={item.code}>{item.name}</option>);
  const copyLog = async () => { try { await navigator.clipboard.writeText(await api.logs()); onNotify("Log zkopírován do schránky."); } catch (error) { onError(error); } };
  return <section className="settings-page"><div className="settings-title"><Heading eyebrow="NASTAVENÍ" title="Nastavení aplikace"/><span><Check/> Změny se ukládají automaticky</span></div><p className="lead">Správa úložiště, stahování, knihovny a výchozího chování přehrávače.</p>
    <div className="settings-grid">
      <section className="panel settings-section storage-section"><SettingsSectionHead icon={<HardDrive/>} title="Úložiště" text="Cílový adresář uvnitř Docker kontejneru"/><div className="storage-path"><span>Docker cesta</span><code>/downloads</code></div><p>Skutečné umístění na Macu nebo NASu určuje <code>DOWNLOAD_PATH</code> v souboru <code>.env</code>. Podsložky jednotlivých providerů nastavíte na stránce Doplňky.</p></section>
      <section className="panel settings-section"><SettingsSectionHead icon={<Download/>} title="Stahování" text="Výkon fronty a zatížení úložiště"/><SettingControl title="Souběžná stahování" text="Na slabším NAS doporučujeme 1–2 soubory současně."><select aria-label="Souběžná stahování" value={settings.concurrentDownloads} onChange={(event) => void onSave({ concurrentDownloads: Number(event.target.value) })}>{[1,2,3,4,5,6,7,8].map((value) => <option key={value} value={value}>{value}</option>)}</select></SettingControl></section>
      <section className="panel settings-section"><SettingsSectionHead icon={<Library/>} title="Knihovna" text="Zobrazení výsledků z více doplňků"/><SettingControl title="Stejné tituly" text="Shodný název a rok lze sloučit do jedné položky."><select aria-label="Stejné tituly" value={settings.mergeByName ? "1" : "0"} onChange={(event) => void onSave({ mergeByName: event.target.value === "1" })}><option value="1">Slučovat</option><option value="0">Zobrazit zvlášť</option></select></SettingControl></section>
      <section className="panel settings-section playback-section"><SettingsSectionHead icon={<CirclePlay/>} title="Přehrávání" text="Preferované stopy při spuštění videa"/><div className="playback-settings"><SettingControl title="Jazyk zvuku" text="Při nedostupnosti se použije angličtina."><select aria-label="Preferovaný jazyk zvuku" value={settings.audioLanguage} onChange={(event) => void onSave({ audioLanguage: event.target.value })}>{languageOptions}</select></SettingControl><SettingControl title="Jazyk titulků" text="Vestavěné titulky mají přednost před doplňkem."><select aria-label="Preferovaný jazyk titulků" value={settings.subtitleLanguage} onChange={(event) => void onSave({ subtitleLanguage: event.target.value })}>{languageOptions}</select></SettingControl></div></section>
      <section className="panel settings-section diagnostics-section"><SettingsSectionHead icon={<FileText/>} title="Diagnostika" text="Log pro hledání problémů se stahováním a sítí"/><p>Log neobsahuje URL streamů ani přístupové tokeny.</p><div className="log-actions"><a className="button" href="/api/logs" download="stremio-offline.log">Stáhnout log</a><button onClick={() => void copyLog()}>Kopírovat do schránky</button></div></section>
    </div>
  </section>;
}

function SettingsSectionHead({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="settings-section-head"><i>{icon}</i><span><strong>{title}</strong><small>{text}</small></span></div>; }
function SettingControl({ title, text, children }: { title: string; text: string; children: React.ReactNode }) { return <label className="setting-control"><span><strong>{title}</strong><small>{text}</small></span>{children}</label>; }

function Addons({ addons, onChanged, onNotify, onError }: { addons: Addon[]; onChanged: () => Promise<void>; onNotify: (s:string)=>void; onError:(e:unknown)=>void }) {
  const [url, setUrl] = useState(""); const [role, setRole] = useState("both"); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { await api.addAddon(url, role); setUrl(""); await onChanged(); onNotify("Manifest byl přidán."); } catch (err) { onError(err); } finally { setBusy(false); } };
  return <section><Heading eyebrow="DOPLŇKY" title="Knihovny a zdroje"/><p className="lead">Vložte adresu končící na <code>manifest.json</code>. Personalizovaná URL může obsahovat citlivý token; v rozhraní ji po uložení skryjeme. Umístění souborů se nastavuje jen u doplňků, které poskytují streamy.</p>
    <form className="panel addon-form" onSubmit={submit}><label><span>URL manifestu</span><input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://…/manifest.json" required/></label><label><span>Úloha</span><select value={role} onChange={(e)=>setRole(e.target.value)}><option value="both">Automaticky / obojí</option><option value="catalog">Pouze knihovna</option><option value="source">Pouze zdroje</option></select></label><button className="primary" disabled={busy}><Plus/> Přidat</button></form>
    <div className="addon-grid">{addons.map((addon) => <AddonCard key={addon.key} addon={addon} onChanged={onChanged} onNotify={onNotify} onError={onError}/>)}</div>
  </section>;
}

function AddonCard({ addon, onChanged, onNotify, onError }: { addon: Addon; onChanged: () => Promise<void>; onNotify: (s:string)=>void; onError:(e:unknown)=>void }) {
  const clone = (value: AddonDownloadSettings): AddonDownloadSettings => ({ movie: { ...value.movie }, series: { ...value.series } });
  const [draft, setDraft] = useState<AddonDownloadSettings>(() => clone(addon.downloadSettings));
  const [saving, setSaving] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const providesStreams = (addon.manifest.resources ?? []).some((resource) => typeof resource === "string" ? resource === "stream" : resource.name === "stream");
  useEffect(() => setDraft(clone(addon.downloadSettings)), [addon.downloadSettings]);
  const change = (kind: "movie" | "series", patch: Partial<AddonDownloadSettings["movie"]>) => setDraft((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  const preview = (kind: "movie" | "series") => { const rule = draft[kind]; const folder = rule.subfolder.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""); const root = `/downloads${folder ? `/${folder}` : ""}`; if (kind === "movie") return rule.layout === "flat" ? `${root}/Název filmu.mkv` : `${root}/Název filmu/Název filmu.mkv`; return rule.layout === "flat" ? `${root}/Název seriálu - S01E01 - Název dílu.mkv` : `${root}/Název seriálu/01 serie/01 - Název dílu.mkv`; };
  const save = async () => { setSaving(true); try { const saved = await api.updateAddon(addon.key, { downloadSettings: draft }); setDraft(clone(saved.downloadSettings)); await onChanged(); onNotify(`Ukládání pro ${addon.manifest.name} bylo nastaveno.`); } catch (error) { onError(error); } finally { setSaving(false); } };
  return <article className={`panel addon-card ${storageOpen ? "storage-expanded" : ""}`}>
    {addon.manifest.logo ? <img src={addon.manifest.logo} alt=""/> : <div className="addon-logo"><PackagePlus/></div>}
    <div className="addon-body"><div className="addon-title"><h3>{addon.manifest.name}</h3>{addon.manifest.behaviorHints?.p2p && <span className="p2p">P2P</span>}</div><p>{addon.manifest.description || addon.displayUrl}</p><small>{addon.manifest.version} · {addon.role === "catalog" ? "knihovna" : addon.role === "source" ? "zdroje" : "knihovna i zdroje"}</small></div>
    <div className="addon-actions"><label className="switch"><input type="checkbox" checked={addon.enabled} onChange={async (event)=>{try { await api.toggleAddon(addon.key,event.target.checked); await onChanged(); } catch (error) { onError(error); }}}/><span/></label><button className="danger icon-button" title="Odstranit" onClick={async()=>{try { await api.deleteAddon(addon.key); await onChanged(); } catch (error) { onError(error); }}}><Trash2/></button></div>
    {providesStreams && <button className={`storage-toggle ${storageOpen ? "open" : ""}`} onClick={() => setStorageOpen((value) => !value)} aria-expanded={storageOpen}><FolderCog/> <span>Nastavení ukládání</span><ChevronDown/></button>}
    {providesStreams && storageOpen && <div className="addon-download-settings"><div className="addon-download-head"><strong>Kam ukládat soubory</strong><small>Hostitelský adresář je určený pomocí <code>DOWNLOAD_PATH</code>. Zde vybíráte pouze podsložku uvnitř <code>/downloads</code>.</small></div>
      <div className="download-rule-grid">{(["movie", "series"] as const).map((kind) => <div className="download-rule" key={kind}><b>{kind === "movie" ? "Filmy" : "Seriály"}</b><label className="folder-label"><span>Podsložka v /downloads</span><div className="folder-field"><code>/downloads/</code><input aria-label={`${kind === "movie" ? "Filmy" : "Seriály"} – podsložka v downloads`} value={draft[kind].subfolder} onChange={(event) => change(kind, { subfolder: event.target.value })} placeholder="prázdné = základní složka"/></div></label><label><span>Způsob uložení</span><select aria-label={`${kind === "movie" ? "Filmy" : "Seriály"} – způsob uložení`} value={draft[kind].layout} onChange={(event) => change(kind, { layout: event.target.value as "flat" | "structured" })}><option value="structured">Složka podle filmu / seriálu</option><option value="flat">Plochá struktura – jen soubory</option></select></label><small className="path-preview">Příklad: <code>{preview(kind)}</code></small></div>)}</div>
      <div className="download-settings-actions"><button onClick={() => { setDraft(clone(addon.downloadSettings)); setStorageOpen(false); }}>Zrušit</button><button className="primary save-download-settings" disabled={saving} onClick={() => void save()}>{saving ? "Ukládám…" : "Uložit nastavení"}</button></div>
    </div>}
  </article>;
}

function Downloads({ jobs, refresh, onError }: { jobs: DownloadJob[]; refresh: () => Promise<void>; onError: (e: unknown) => void }) {
  const active = jobs.filter((job) => job.status === "downloading"); const totalSpeed = active.reduce((sum, job) => sum + job.speed, 0); const eta = (job: DownloadJob) => job.speed > 0 && job.total ? fmtEta((job.total - job.received) / job.speed) : "—";
  const action = async (operation: () => Promise<void>) => { try { await operation(); await refresh(); } catch (error) { onError(error); } };
  return <section><div className="download-title"><Heading eyebrow="STAHOVÁNÍ" title="Fronta"/><button disabled={!jobs.some((job) => job.status === "completed")} onClick={() => action(api.clearCompleted)}><Trash2/> Vyčistit dokončené</button></div><div className="summary"><div><b>{jobs.length}</b><span>položek</span></div><div><b>{active.length}</b><span>probíhá</span></div><div><b>{speed(totalSpeed)}</b><span>celková rychlost</span></div></div><div className="panel downloads"><div className="download-head"><span>Název</span><span>Stav</span><span>Průběh</span><span>Rychlost / zbývá</span><span>Akce</span></div>{jobs.map((job)=><div className="download-row" key={job.id}><div><strong>{job.title}</strong><small>{job.target}{job.error ? ` · ${job.error}`:""}</small></div><span className={`job-status ${job.status}`}>{statusLabel(job.status)}</span><div><span>{bytes(job.received)} / {bytes(job.total)}</span><div className="progress"><i style={{width:`${job.total ? Math.min(100, job.received/job.total*100):0}%`}}/></div></div><span>{speed(job.speed)}<small>{eta(job)}</small></span><div className="queue-actions"><button title="Nahoru" disabled={job.order === 0 || job.status === "downloading"} onClick={() => action(() => api.moveDownload(job.id, -1))}><ArrowUp/></button><button title="Dolů" disabled={job.order === jobs.length - 1 || job.status === "downloading"} onClick={() => action(() => api.moveDownload(job.id, 1))}><ArrowDown/></button>{job.status === "downloading" || job.status === "queued" ? <button title="Pozastavit" onClick={() => action(() => api.downloadAction(job.id,"pause"))}><Pause/></button> : job.status === "paused" ? <button title="Pokračovat" onClick={() => action(() => api.downloadAction(job.id,"resume"))}><Play/></button> : job.status === "failed" ? <button title="Zkusit znovu" onClick={() => action(() => api.downloadAction(job.id,"retry"))}><RefreshCw/></button> : null}<button className="danger" title="Odstranit z fronty" onClick={() => action(() => api.removeDownload(job.id))}><Trash2/></button></div></div>)}{!jobs.length && <Empty icon={<Download/>} title="Fronta je prázdná" text="Vyberte přímý HTTP stream a použijte tlačítko Stáhnout."/>}</div></section>;
}
const fmtEta = (seconds: number) => seconds < 60 ? `${Math.ceil(seconds)} s` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min`;
const statusLabel = (status: DownloadJob["status"]) => ({ queued: "Ve frontě", downloading: "Stahuji", paused: "Pozastaveno", completed: "Dokončeno", failed: "Chyba" })[status];
