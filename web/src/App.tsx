import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, FileJson, Link2, LogOut, ChevronDown, ChevronRight, CirclePlay, Download, FileText, Film, FolderCog, HardDrive, Library, PackagePlus, Pause, Play, Plus, RefreshCw, Search, Settings, Subtitles, Trash2, X } from "lucide-react";
import { api, ApiError } from "./api";
import { AccountSettings, LoginScreen } from "./Login";
import { SettingControl, SettingsSectionHead } from "./settings-ui";
import { Player } from "./Player";
import { guessLanguages, label } from "./languages";
import { arrangeStreams, streamLanguages, streamSize, type StreamSort } from "./streams";
import type { Addon, AddonDownloadSettings, Catalog, Download as DownloadJob, Inspection, Meta, Session, Settings as AppSettings, Stream, Subtitle, Video } from "./types";

type View = "catalog" | "downloads" | "addons" | "settings";
const bytes = (value?: number) => !value ? "—" : value > 1e9 ? `${(value / 1e9).toFixed(1)} GB` : value > 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${Math.round(value / 1e3)} kB`;
const speed = (value: number) => value ? `${bytes(value)}/s` : "—";
const streamLabel = (item: Stream) => item.name || item.title?.split("\n")[0] || item.description?.split("\n")[0] || (item.infoHash ? "Torrent" : "Stream");

export function App() {
  const [view, setView] = useState<View>("catalog"); const [addons, setAddons] = useState<Addon[]>([]); const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [selectedCatalog, setSelectedCatalog] = useState(""); const [search, setSearch] = useState(""); const [items, setItems] = useState<Meta[]>([]); const [selected, setSelected] = useState<Meta | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null); const [streams, setStreams] = useState<Stream[]>([]); const [selectedStream, setSelectedStream] = useState<Stream | null>(null); const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [episodesOpen, setEpisodesOpen] = useState(true);
  const [season, setSeason] = useState<number | null>(null);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [playerOpen, setPlayerOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({ concurrentDownloads: 1, audioLanguage: "cs", subtitleLanguage: "cs", mergeByName: true, streamSort: "recommended" });
  const [languages, setLanguages] = useState<Array<{ code: string; name: string }>>([]);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [streamAddon, setStreamAddon] = useState(""); const [streamLanguage, setStreamLanguage] = useState(""); const [streamSort, setStreamSort] = useState<StreamSort>("recommended");
  useEffect(() => { setStreamSort(settings.streamSort as StreamSort); }, [settings.streamSort]);
  const [submittedQuery, setSubmittedQuery] = useState(""); const [searchAddon, setSearchAddon] = useState(""); const [searchable, setSearchable] = useState<Array<{ addonKey: string; addonName: string }>>([]); const [typeFilter, setTypeFilter] = useState(""); const [genre, setGenre] = useState(""); const [sort, setSort] = useState("default");
  const [skip, setSkip] = useState(0); const [cursor, setCursor] = useState(""); const [hasMore, setHasMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false); const [sourceCount, setSourceCount] = useState(0);
  const [pendingSources, setPendingSources] = useState(0);
  const pickedRef = useRef(false); const sourcesRequestRef = useRef(0);
  const loadingRef = useRef(false); const requestRef = useRef(0); const itemsRef = useRef<Meta[]>([]); const gridRef = useRef<HTMLDivElement>(null);
  const currentCatalog = catalogs.find((catalog) => `${catalog.addonKey}:${catalog.type}:${catalog.id}` === selectedCatalog) ?? catalogs[0];
  const searchRequired = Boolean(currentCatalog?.extra?.some((extra) => extra.name === "search" && extra.isRequired));
  const videoId = selectedVideo?.id || selected?.id; const videoTitle = selectedVideo ? `${selected?.name} · ${selectedVideo.title || selectedVideo.name || `S${selectedVideo.season}E${selectedVideo.episode}`}` : selected?.name || "Video";
  // Dlouhé seriály mají stovky dílů; seznam se proto větví po sériích. Speciály (season 0) patří na konec.
  const seasons = [...new Set((selected?.videos ?? []).map((video) => video.season).filter((value): value is number => typeof value === "number"))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const activeSeason = season ?? selectedVideo?.season ?? seasons.find((value) => value > 0) ?? seasons[0] ?? null;
  const visibleEpisodes = (selected?.videos ?? []).filter((video) => seasons.length <= 1 || activeSeason === null || video.season === activeSeason);
  const notify = (text: string) => { setMessage(text); setTimeout(() => setMessage(""), 3200); };
  const fail = (value: unknown) => {
    if (value instanceof ApiError && value.status === 401) { setSession(null); return; }
    setError(value instanceof Error ? value.message : String(value)); setTimeout(() => setError(""), 6000);
  };

  const refresh = async () => {
    const [nextAddons, nextCatalogs] = await Promise.all([api.addons(), api.catalogs()]); setAddons(nextAddons); setCatalogs(nextCatalogs);
    if (!selectedCatalog && nextCatalogs[0]) setSelectedCatalog(`${nextCatalogs[0].addonKey}:${nextCatalogs[0].type}:${nextCatalogs[0].id}`);
  };
  const loadDownloads = () => api.downloads().then(setDownloads).catch(fail);
  useEffect(() => { api.me().then(setSession).catch(() => setSession(null)); }, []);
  const ready = Boolean(session && !session.mustChangePassword);
  // Načítat data má smysl až po přihlášení, jinak by to jen sypalo chyby 401.
  useEffect(() => { if (!ready) return; refresh().catch(fail); loadDownloads(); api.settings().then(setSettings).catch(fail); api.languages().then(setLanguages).catch(() => undefined); }, [ready]);
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
  useEffect(() => { if (!ready) return; loadDownloads(); const timer = setInterval(loadDownloads, view === "downloads" ? 1200 : 5000); return () => clearInterval(timer); }, [view, ready]);

  const genreOptions = currentCatalog?.extra?.find((extra) => extra.name === "genre")?.options ?? [];
  // Žánr patří konkrétnímu katalogu. Po přepnutí katalogu zmizí z nabídky, ale ve stavu
  // zůstane, a katalog na neznámý žánr nevrátí nic. Bereme ho proto jen když existuje.
  const activeGenre = genreOptions.includes(genre) ? genre : "";

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
        const metas = await api.catalog(currentCatalog!, "", from, activeGenre);
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
    [submittedQuery, searchAddon, typeFilter, activeGenre, currentCatalog?.addonKey, currentCatalog?.type, currentCatalog?.id]);

  // Mřížka je vlastní posuvník. Obyčejný posluchač scrollu funguje i tam,
  // kde IntersectionObserver mlčí (skrytý dokument, úsporné režimy).
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !hasMore) return;
    const onScroll = () => { if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) void loadPage(false); };
    grid.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => grid.removeEventListener("scroll", onScroll);
  }, [hasMore, skip, cursor, submittedQuery, searchAddon, typeFilter, activeGenre, currentCatalog?.addonKey, currentCatalog?.type, currentCatalog?.id]);

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

  // Priorita doplňku je jeho pořadí v seznamu; nastavuje se šipkami na kartě doplňku.
  const addonPriority = useMemo(() => new Map(addons.map((addon, index) => [addon.manifest.name, index])), [addons]);
  const visibleStreams = useMemo(
    () => arrangeStreams(streams, { addon: streamAddon, language: streamLanguage, sort: streamSort }, settings.audioLanguage, addonPriority),
    [streams, streamAddon, streamLanguage, streamSort, settings.audioLanguage, addonPriority]);
  // Počty v každé nabídce platí pro to, co projde tím druhým filtrem, jinak by si odporovaly.
  const byLanguage = useMemo(
    () => streamLanguage ? streams.filter((stream) => streamLanguages(stream).includes(streamLanguage)) : streams,
    [streams, streamLanguage]);
  const byAddon = useMemo(
    () => streamAddon ? streams.filter((stream) => stream.addonName === streamAddon) : streams,
    [streams, streamAddon]);

  const streamAddons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const stream of byLanguage) { const name = stream.addonName ?? "?"; counts.set(name, (counts.get(name) ?? 0) + 1); }
    // Zvolený doplněk musí v nabídce zůstat, i když na něj nic nezbylo, jinak by pole zprázdnělo.
    if (streamAddon && !counts.has(streamAddon)) counts.set(streamAddon, 0);
    const rank = (name: string) => addonPriority.get(name) ?? Number.MAX_SAFE_INTEGER;
    return [...counts.entries()].sort((a, b) => (rank(a[0]) - rank(b[0])) || (b[1] - a[1]));
  }, [byLanguage, streamAddon, addonPriority]);
  const streamLangs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const stream of byAddon) for (const code of streamLanguages(stream)) counts.set(code, (counts.get(code) ?? 0) + 1);
    if (streamLanguage && !counts.has(streamLanguage)) counts.set(streamLanguage, 0);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [byAddon, streamLanguage]);
  // Když filtr odstraní vybraný zdroj, výběr se posune na první zbylý.
  useEffect(() => {
    if (!visibleStreams.length) { if (selectedStream) setSelectedStream(null); return; }
    if (!selectedStream || !visibleStreams.includes(selectedStream)) { setSelectedStream(visibleStreams[0]); return; }
    // Během donačítání může přijít lepší zdroj; vlastní volbu uživatele ale nepřebíjíme.
    if (!pickedRef.current && pendingSources > 0 && selectedStream !== visibleStreams[0]) setSelectedStream(visibleStreams[0]);
  }, [visibleStreams, pendingSources]);

  const visibleItems = useMemo(() => {
    const year = (item: Meta) => Number(String(item.releaseInfo ?? item.year ?? "").slice(0, 4)) || 0;
    const list = settings.mergeByName ? groupByName(items) : [...items];
    if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "cs"));
    else if (sort === "year") list.sort((a, b) => year(b) - year(a));
    return list;
  }, [items, sort, settings.mergeByName]);
  /** Každý doplněk se ptá zvlášť, aby se výsledky ukazovaly průběžně a nečekalo se na nejpomalejší. */
  const fetchSources = async (type: string, id: string, video?: Video) => {
    const request = ++sourcesRequestRef.current;
    const stale = () => request !== sourcesRequestRef.current;
    setSelectedVideo(video ?? null); setSourcesLoaded(false); setBusy(true);
    setStreams([]); setSelectedStream(null); setSubtitles([]); setPendingSources(0);
    pickedRef.current = false;
    try {
      const [sources, nextSubtitles] = await Promise.all([api.streamSources(type, id), api.subtitles(type, id)]);
      if (stale()) return;
      setSubtitles(nextSubtitles); setSourcesLoaded(true); setBusy(false); setPendingSources(sources.length);
      await Promise.all(sources.map(async (source) => {
        try {
          const part = await api.streams(type, id, source.key);
          if (!stale() && part.length) setStreams((previous) => [...previous, ...part]);
        } catch (error) {
          // Jeden nedostupný doplněk nesmí zbytek shodit ani zahltit chybami.
          if (!stale()) console.warn(`Zdroje z ${source.name} se nepodařilo načíst`, error);
        } finally { if (!stale()) setPendingSources((count) => count - 1); }
      }));
    } catch (e) { if (!stale()) { fail(e); setSourcesLoaded(true); } }
    finally { if (!stale()) setBusy(false); }
  };
  const openMeta = async (item: Meta) => {
    setSelected(item); setSelectedVideo(null); setEpisodesOpen(true); setSeason(null); setStreams([]); setSelectedStream(null); setSubtitles([]); setSourcesLoaded(false);
    const type = item.type || currentCatalog?.type || "movie";
    let detail = item;
    try { detail = { ...item, ...await api.meta(type, item.id) }; setSelected(detail); } catch { /* catalog item is still useful */ }
    if (type !== "series" && !detail.videos?.length) await fetchSources(type, item.id);
  };
  const loadSources = async (video?: Video) => {
    if (!selected) return; await fetchSources(selected.type || currentCatalog?.type || "movie", video?.id || selected.id, video);
  };
  const enqueue = async () => {
    if (!selectedStream) return false;
    // Server podle toho poskládá cestu; bez těchto údajů by z epizody byl placatý soubor.
    const media = selectedVideo
      ? { kind: "episode", title: selected?.name, season: selectedVideo.season, episode: selectedVideo.episode, episodeTitle: selectedVideo.title || selectedVideo.name }
      : { kind: "movie", title: selected?.name };
    try { await api.download(videoTitle, selectedStream, media); notify("Přidáno do stahovací fronty."); await loadDownloads(); return true; } catch (e) { fail(e); return false; }
  };

  /** Hromadné stažení: fronta dostane líné úlohy a zdroj (největší v preferovaném jazyce)
   *  si každá vybere sama, až na ni dojde řada. Doplňky tak nedostanou lavinu dotazů naráz. */
  const enqueueEpisodes = async (scope: "series" | "season") => {
    if (!selected?.videos?.length) return;
    const now = Date.now();
    const episodes = selected.videos.filter((video) => {
      if (!video.id) return false;
      if (scope === "season" && video.season !== activeSeason) return false;
      // Celý seriál = řádné série; speciály (season 0) a dosud nevydané díly se přeskakují.
      if (scope === "series" && typeof video.season === "number" && video.season <= 0) return false;
      if (video.released && Date.parse(String(video.released)) > now) return false;
      return true;
    });
    if (!episodes.length) { fail(new Error("Žádné epizody ke stažení.")); return; }
    const label = scope === "season"
      ? (activeSeason === 0 ? `${episodes.length} speciálů` : `${episodes.length} epizod ${activeSeason}. série`)
      : `všech ${episodes.length} epizod seriálu`;
    if (!window.confirm(`Přidat ${label} do fronty? Zdroj se pro každou epizodu vybere automaticky až při stahování.`)) return;
    try {
      const result = await api.downloadBulk(selected.name, selected.type || currentCatalog?.type || "series", episodes.map((video) => ({ id: String(video.id), season: video.season, episode: video.episode, title: video.title || video.name })));
      notify(`Do fronty přidáno ${result.added} epizod${result.skipped ? `, ${result.skipped} přeskočeno (už ve frontě)` : ""}.`);
      await loadDownloads();
    } catch (e) { fail(e); }
  };

  if (session === undefined) return <div className="login-screen"><div className="loading">Načítám…</div></div>;
  if (!ready) return <LoginScreen session={session} onSession={setSession}/>;

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><CirclePlay/></div><div><small>DOMÁCÍ MEDIATÉKA</small><h1>Stremio <span>Offline</span></h1></div></div><div className="topbar-right"><div className="online"><i/> Docker server online</div>
      <button className="signout" title={`Přihlášen jako ${session?.username ?? ""}`} onClick={async () => { try { await api.logout(); } finally { location.reload(); } }}><LogOut/> Odhlásit</button></div></header>
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
                  {genreOptions.length > 0 && <label><span>Žánr</span><select value={activeGenre} onChange={(e) => setGenre(e.target.value)}><option value="">Všechny</option>{genreOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>}
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
          </section><section className={`panel detail-panel ${Boolean(selected?.videos?.length) && selectedVideo && sourcesLoaded && !episodesOpen ? "series-sources-layout" : ""}`}>{selected ? <>
            <div className={`hero ${selected.videos?.length ? "series-hero" : ""}`} style={selected.background ? { backgroundImage: `linear-gradient(90deg,#121721 25%,transparent),url(${selected.background})` } : undefined}><div className="detail-copy"><span className="pill">{selected.type === "series" ? "Seriál" : "Film"}</span><h2>{selected.name}</h2><p className="meta-line">{[selected.releaseInfo || selected.year, ...(selected.genres || []).slice(0, 3)].filter(Boolean).join(" · ")}</p><p>{selected.description || "Bez popisu."}</p></div></div>
            {selected.videos?.length ? <div className={`episodes ${selectedVideo && !episodesOpen ? "collapsed" : ""}`}>{selectedVideo && !episodesOpen ? <div className="episode-current"><small>Vybraná epizoda</small><b>{selectedVideo.season != null ? `${String(selectedVideo.season).padStart(2,"0")}×${String(selectedVideo.episode || 0).padStart(2,"0")}` : "Díl"}</b><span>{selectedVideo.title || selectedVideo.name || "Epizoda"}</span><button onClick={() => setEpisodesOpen(true)}>Změnit epizodu</button></div> : <><div className="subhead episode-head"><h3>Epizody</h3><div className="episode-tools">{seasons.length > 1 && <select className="season-select" aria-label="Série" value={activeSeason ?? ""} onChange={(event) => setSeason(Number(event.target.value))}>{seasons.map((value) => <option key={value} value={value}>{value === 0 ? "Speciály" : `${value}. série`}</option>)}</select>}{activeSeason != null && <button title={activeSeason === 0 ? "Stáhnout všechny speciály" : `Stáhnout všechny epizody ${activeSeason}. série`} onClick={() => void enqueueEpisodes("season")}><Download/> {activeSeason === 0 ? "Speciály" : `Série ${activeSeason}`}</button>}<button title="Stáhnout celý seriál" onClick={() => void enqueueEpisodes("series")}><Download/> Celý seriál</button>{selectedVideo ? <button onClick={() => setEpisodesOpen(false)}>Sbalit</button> : <span>{visibleEpisodes.length}</span>}</div></div><div className="episode-list">{visibleEpisodes.map((video, index) => <button key={video.id || index} className={selectedVideo?.id === video.id ? "selected" : ""} onClick={() => { setEpisodesOpen(false); void loadSources(video); }}><b>{video.season != null ? `${String(video.season).padStart(2,"0")}×${String(video.episode || 0).padStart(2,"0")}` : index + 1}</b><span>{video.title || video.name || "Epizoda"}</span><ChevronRight/></button>)}</div></>}</div> : !sourcesLoaded && <button className="primary wide" onClick={() => loadSources()} disabled={busy}>Načíst zdroje</button>}
            {sourcesLoaded && <div className="sources"><div className="subhead"><h3>Zdroje</h3><span>{visibleStreams.length === streams.length ? streams.length : `${visibleStreams.length} z ${streams.length}`}{pendingSources > 0 ? ` · načítám z ${pendingSources} ${pendingSources === 1 ? "doplňku" : "doplňků"}…` : ""}</span></div>
              {streams.length > 1 && <div className="stream-filters">
                <label><span>Doplněk</span><select value={streamAddon} onChange={(event) => setStreamAddon(event.target.value)}>
                  <option value="">Všechny ({byLanguage.length})</option>
                  {streamAddons.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
                </select></label>
                {streamLangs.length > 0 && <label><span>Jazyk</span><select value={streamLanguage} onChange={(event) => setStreamLanguage(event.target.value)}>
                  <option value="">Libovolný ({byAddon.length})</option>
                  {streamLangs.map(([code, count]) => <option key={code} value={code}>{label(code)} ({count})</option>)}
                </select></label>}
                <label><span>Řazení</span><select value={streamSort} onChange={(event) => setStreamSort(event.target.value as StreamSort)}>
                  <option value="recommended">Doporučené</option>
                  <option value="size-desc">Od největšího</option>
                  <option value="size-asc">Od nejmenšího</option>
                  <option value="addon">Podle priority doplňku</option>
                </select></label>
              </div>}<div className="stream-list">{visibleStreams.map((stream, index) => <button key={index} className={selectedStream === stream ? "selected" : ""} onClick={() => { pickedRef.current = true; setSelectedStream(stream); }}><i>{stream.url ? "HTTP" : stream.infoHash ? "P2P" : "EXT"}</i><span><strong>{streamLabel(stream)}</strong><small>{stream.addonName} {streamSize(stream) ? `· ${bytes(streamSize(stream))}` : ""} {guessLanguages([stream.name, stream.title, stream.description, stream.behaviorHints?.filename].filter(Boolean).join(" ")).map((code) => <em className="lang-badge" key={code} title="Odhad z názvu od doplňku, nemusí odpovídat souboru">{label(code)}</em>)}</small></span>{selectedStream === stream && <Check/>}</button>)}</div>
              {!streams.length && pendingSources === 0 && <div className="no-sources">Žádný aktivní zdrojový doplněk pro tento titul nevrátil stream.</div>}
              {!streams.length && pendingSources > 0 && <div className="no-sources">Ptám se doplňků…</div>}
              {Boolean(streams.length) && !visibleStreams.length && <div className="no-sources">Žádný z {streams.length} zdrojů neodpovídá filtru. <button className="link-button" onClick={() => { setStreamAddon(""); setStreamLanguage(""); }}>Zrušit filtry</button></div>}
              {selectedStream?.infoHash && !selectedStream.url && <p className="notice">Tento doplněk vrátil nezpracovaný torrent. Přímé Real-Debrid rozlišení přidáme v další etapě; RD doplněk obvykle vrací rovnou HTTPS adresu.</p>}
              <div className="source-footer"><div className="source-info"><Subtitles/> {subtitles.length + (selectedStream?.subtitles?.length || 0)} titulků z doplňků
                {inspection && <> · <b>zvuk v souboru</b> {inspection.audioTracks.length ? inspection.audioTracks.map((track, index) => <em className="lang-badge" key={index}>{label(track.language)}</em>) : "—"}
                · <b>titulky v souboru</b> {inspection.subtitleTracks.length ? inspection.subtitleTracks.map((track, index) => <em className="lang-badge" key={index}>{label(track.language)}</em>) : "—"}</>}
                {selectedStream?.url && !inspection && <> · zjišťuji stopy…</>}</div><div className="actions"><button className="primary" disabled={!selectedStream?.url} onClick={() => setPlayerOpen(true)}><CirclePlay/> Přehrát</button><button disabled={!selectedStream?.url} onClick={enqueue}><Download/> Stáhnout</button>{selectedStream?.externalUrl && <a className="button" href={selectedStream.externalUrl} target="_blank">Otevřít externě</a>}</div></div>
            </div>}
          </> : <Empty icon={<Film/>} title="Vyberte titul" text="Zobrazí se podrobnosti, epizody a zdroje ze všech aktivních doplňků."/>}</section></div>
        </>}
      </section>}
      {view === "addons" && <Addons addons={addons} onChanged={refresh} onNotify={notify} onError={fail}/>} 
      {view === "downloads" && <Downloads jobs={downloads} refresh={loadDownloads} onError={fail}/>}
      {view === "settings" && <SettingsPage settings={settings} languages={languages} session={session!} onSession={setSession} onSave={saveSettings} onNotify={notify} onError={fail}/>}
    </main>
    <Player open={playerOpen} title={videoTitle} stream={selectedStream} subtitles={subtitles} subtitleLanguage={settings.subtitleLanguage} onDownload={enqueue} onClose={() => setPlayerOpen(false)}/>
    {(message || error) && <div className={`toast ${error ? "error" : ""}`}>{error || message}<button onClick={() => {setError("");setMessage("");}}><X/></button></div>}
  </div>;
}

function Nav({ icon, label, active, badge, onClick }: { icon: React.ReactNode; label: string; active: boolean; badge?: number; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}>{icon}<span>{label}</span>{badge != null && <b>{badge}</b>}</button>; }
function Heading({ eyebrow, title }: { eyebrow: string; title: string }) { return <div className="heading"><small>{eyebrow}</small><h2>{title}</h2></div>; }
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="empty"><i>{icon}</i><h3>{title}</h3><p>{text}</p></div>; }
function Onboarding({ onOpen }: { onOpen: () => void }) { return <div className="panel onboarding"><i><PackagePlus/></i><h2>Přidejte první Stremio doplněk</h2><p>Aplikace potřebuje alespoň jeden katalogový manifest. Zdrojové manifesty s Real-Debrid můžete přidat samostatně.</p><button className="primary" onClick={onOpen}><Plus/> Přidat manifest</button></div>; }

function SettingsPage({ settings, languages, session, onSession, onSave, onNotify, onError }: { settings: AppSettings; languages: Array<{ code: string; name: string }>; session: Session; onSession: (session: Session) => void; onSave: (patch: Partial<AppSettings>) => Promise<void>; onNotify: (message: string) => void; onError: (error: unknown) => void }) {
  const languageOptions = languages.map((item) => <option key={item.code} value={item.code}>{item.name}</option>);
  const copyLog = async () => { try { await navigator.clipboard.writeText(await api.logs()); onNotify("Log zkopírován do schránky."); } catch (error) { onError(error); } };
  return <section className="settings-page"><div className="settings-title"><Heading eyebrow="NASTAVENÍ" title="Nastavení aplikace"/><span><Check/> Změny se ukládají automaticky</span></div><p className="lead">Správa úložiště, stahování, knihovny a výchozího chování přehrávače.</p>
    <div className="settings-grid">
      <AccountSettings session={session} onSession={onSession} onNotify={onNotify} onError={onError}/>
      <section className="panel settings-section storage-section"><SettingsSectionHead icon={<HardDrive/>} title="Úložiště" text="Cílový adresář uvnitř Docker kontejneru"/><div className="storage-path"><span>Docker cesta</span><code>/downloads</code></div><p>Skutečné umístění na Macu nebo NASu určuje <code>DOWNLOAD_PATH</code> v souboru <code>.env</code>. Podsložky jednotlivých providerů nastavíte na stránce Doplňky.</p></section>
      <section className="panel settings-section"><SettingsSectionHead icon={<Download/>} title="Stahování" text="Výkon fronty a zatížení úložiště"/><SettingControl title="Souběžná stahování" text="Na slabším NAS doporučujeme 1–2 soubory současně."><select aria-label="Souběžná stahování" value={settings.concurrentDownloads} onChange={(event) => void onSave({ concurrentDownloads: Number(event.target.value) })}>{[1,2,3,4,5,6,7,8].map((value) => <option key={value} value={value}>{value}</option>)}</select></SettingControl></section>
      <section className="panel settings-section"><SettingsSectionHead icon={<Library/>} title="Knihovna" text="Zobrazení výsledků z více doplňků"/><SettingControl title="Stejné tituly" text="Shodný název a rok lze sloučit do jedné položky."><select aria-label="Stejné tituly" value={settings.mergeByName ? "1" : "0"} onChange={(event) => void onSave({ mergeByName: event.target.value === "1" })}><option value="1">Slučovat</option><option value="0">Zobrazit zvlášť</option></select></SettingControl><SettingControl title="Výchozí řazení zdrojů" text="Doporučené dá dopředu preferovaný jazyk, pak doplňky s vyšší prioritou a uvnitř největší soubory."><select aria-label="Výchozí řazení zdrojů" value={settings.streamSort} onChange={(event) => void onSave({ streamSort: event.target.value })}><option value="recommended">Doporučené</option><option value="size-desc">Od největšího</option><option value="size-asc">Od nejmenšího</option><option value="addon">Podle priority doplňku</option></select></SettingControl></section>
      <section className="panel settings-section playback-section"><SettingsSectionHead icon={<CirclePlay/>} title="Přehrávání" text="Preferované stopy při spuštění videa"/><div className="playback-settings"><SettingControl title="Jazyk zvuku" text="Při nedostupnosti se použije angličtina."><select aria-label="Preferovaný jazyk zvuku" value={settings.audioLanguage} onChange={(event) => void onSave({ audioLanguage: event.target.value })}>{languageOptions}</select></SettingControl><SettingControl title="Jazyk titulků" text="Vestavěné titulky mají přednost před doplňkem."><select aria-label="Preferovaný jazyk titulků" value={settings.subtitleLanguage} onChange={(event) => void onSave({ subtitleLanguage: event.target.value })}>{languageOptions}</select></SettingControl></div></section>
      <section className="panel settings-section diagnostics-section"><SettingsSectionHead icon={<FileText/>} title="Diagnostika" text="Log pro hledání problémů se stahováním a sítí"/><p>Log neobsahuje URL streamů ani přístupové tokeny.</p><div className="log-actions"><a className="button" href="/api/logs" download="stremio-offline.log">Stáhnout log</a><button onClick={() => void copyLog()}>Kopírovat do schránky</button></div></section>
    </div>
  </section>;
}


function Addons({ addons, onChanged, onNotify, onError }: { addons: Addon[]; onChanged: () => Promise<void>; onNotify: (s:string)=>void; onError:(e:unknown)=>void }) {
  const [url, setUrl] = useState(""); const [role, setRole] = useState("both"); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); try { await api.addAddon(url, role); setUrl(""); await onChanged(); onNotify("Manifest byl přidán."); } catch (err) { onError(err); } finally { setBusy(false); } };
  return <section><Heading eyebrow="DOPLŇKY" title="Knihovny a zdroje"/><p className="lead">Vložte adresu končící na <code>manifest.json</code>. Personalizovaná URL může obsahovat citlivý token; v rozhraní ji po uložení skryjeme. Umístění souborů se nastavuje jen u doplňků, které poskytují streamy.</p>
    <form className="panel addon-form" onSubmit={submit}><label><span>URL manifestu</span><input value={url} onChange={(e)=>setUrl(e.target.value)} placeholder="https://…/manifest.json" required/></label><label><span>Úloha</span><select value={role} onChange={(e)=>setRole(e.target.value)}><option value="both">Automaticky / obojí</option><option value="catalog">Pouze knihovna</option><option value="source">Pouze zdroje</option></select></label><button className="primary" disabled={busy}><Plus/> Přidat</button></form>
    {[
      { title: "Zdroje streamů", text: "Pořadí určuje prioritu při řazení zdrojů u titulu.", ordered: true, list: addons.filter((addon) => addon.role !== "catalog") },
      { title: "Knihovny a metadata", text: "Dodávají katalogy, popisy a plakáty.", ordered: false, list: addons.filter((addon) => addon.role === "catalog") },
    ].filter((group) => group.list.length > 0).map((group) => <div className="addon-group" key={group.title}>
      <div className="subhead"><h3>{group.title}</h3><span>{group.text}</span></div>
      <div className="addon-grid">{group.list.map((addon, index) => <AddonCard key={addon.key} addon={addon}
        index={group.ordered ? index : -1} total={group.list.length}
        onChanged={onChanged} onNotify={onNotify} onError={onError}/>)}</div>
    </div>)}
  </section>;
}

function AddonCard({ addon, index, total, onChanged, onNotify, onError }: { addon: Addon; index: number; total: number; onChanged: () => Promise<void>; onNotify: (s:string)=>void; onError:(e:unknown)=>void }) {
  const clone = (value: AddonDownloadSettings): AddonDownloadSettings => ({ movie: { ...value.movie }, series: { ...value.series } });
  const [draft, setDraft] = useState<AddonDownloadSettings>(() => clone(addon.downloadSettings));
  const [saving, setSaving] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestUrl, setManifestUrl] = useState("");
  const [manifestRole, setManifestRole] = useState(addon.role);
  const [manifestBusy, setManifestBusy] = useState(false);

  // Skutečnou adresu rozhraní běžně skrývá kvůli tokenu, načteme ji až při otevření.
  const openManifest = async () => {
    const next = !manifestOpen;
    setManifestOpen(next);
    if (!next || manifestUrl) return;
    try {
      const full = await api.exportAddon(addon.key) as { manifestUrl: string; role: string };
      setManifestUrl(full.manifestUrl); setManifestRole(full.role as Addon["role"]);
    } catch (error) { onError(error); }
  };
  const saveManifest = async () => {
    setManifestBusy(true);
    try { await api.updateAddon(addon.key, { url: manifestUrl.trim(), role: manifestRole }); await onChanged(); onNotify("Doplněk aktualizován."); }
    catch (error) { onError(error); }
    finally { setManifestBusy(false); }
  };
  const exportManifest = async () => {
    try {
      const full = await api.exportAddon(addon.key);
      const blob = new Blob([JSON.stringify(full, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href; link.download = `${addon.manifest.name.replace(/[^\w.-]+/g, "-")}.json`;
      link.click(); URL.revokeObjectURL(href);
      onNotify("Manifest uložen do souboru.");
    } catch (error) { onError(error); }
  };
  const providesStreams = (addon.manifest.resources ?? []).some((resource) => typeof resource === "string" ? resource === "stream" : resource.name === "stream");
  useEffect(() => setDraft(clone(addon.downloadSettings)), [addon.downloadSettings]);
  const change = (kind: "movie" | "series", patch: Partial<AddonDownloadSettings["movie"]>) => setDraft((current) => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  const preview = (kind: "movie" | "series") => { const rule = draft[kind]; const folder = rule.subfolder.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""); const root = `/downloads${folder ? `/${folder}` : ""}`; if (kind === "movie") return rule.layout === "flat" ? `${root}/Název filmu.mkv` : `${root}/Název filmu/Název filmu.mkv`; return rule.layout === "flat" ? `${root}/Název seriálu - S01E01 - Název dílu.mkv` : `${root}/Název seriálu/01 serie/01 - Název dílu.mkv`; };
  const save = async () => { setSaving(true); try { const saved = await api.updateAddon(addon.key, { downloadSettings: draft }); setDraft(clone(saved.downloadSettings)); await onChanged(); onNotify(`Ukládání pro ${addon.manifest.name} bylo nastaveno.`); } catch (error) { onError(error); } finally { setSaving(false); } };
  return <article className={`panel addon-card ${storageOpen ? "storage-expanded" : ""}`}>
    {addon.manifest.logo ? <img src={addon.manifest.logo} alt=""/> : <div className="addon-logo"><PackagePlus/></div>}
    <div className="addon-body"><div className="addon-title"><h3>{addon.manifest.name}</h3>{addon.manifest.behaviorHints?.p2p && <span className="p2p">P2P</span>}</div><p>{addon.manifest.description || addon.displayUrl}</p><small>{addon.manifest.version} · {addon.role === "catalog" ? "knihovna" : addon.role === "source" ? "zdroje" : "knihovna i zdroje"}</small></div>
    <div className="addon-actions">{index >= 0 && <div className="addon-order">
      <button title="Vyšší priorita při řazení zdrojů" disabled={index === 0} onClick={async()=>{try { await api.moveAddon(addon.key, -1); await onChanged(); } catch (error) { onError(error); }}}><ArrowUp/></button>
      <button title="Nižší priorita při řazení zdrojů" disabled={index === total - 1} onClick={async()=>{try { await api.moveAddon(addon.key, 1); await onChanged(); } catch (error) { onError(error); }}}><ArrowDown/></button>
    </div>}<label className="switch"><input type="checkbox" checked={addon.enabled} onChange={async (event)=>{try { await api.toggleAddon(addon.key,event.target.checked); await onChanged(); } catch (error) { onError(error); }}}/><span/></label><button className="danger icon-button" title="Odstranit" onClick={async()=>{try { await api.deleteAddon(addon.key); await onChanged(); } catch (error) { onError(error); }}}><Trash2/></button></div>
    <button className={`storage-toggle ${manifestOpen ? "open" : ""}`} onClick={() => void openManifest()} aria-expanded={manifestOpen}><Link2/> <span>Manifest a export</span><ChevronDown/></button>
    {manifestOpen && <div className="addon-download-settings">
      <div className="addon-download-head"><strong>Adresa manifestu</strong><small>Po překonfigurování doplňku sem vložte novou adresu. Pořadí, zapnutí i nastavení ukládání zůstanou zachovány. Adresa může obsahovat přístupový token, zacházejte s ní jako s heslem.</small></div>
      <label className="manifest-field"><span>URL</span>
        <input value={manifestUrl} onChange={(event) => setManifestUrl(event.target.value)} placeholder="načítám…" spellCheck={false}/></label>
      <label className="manifest-field"><span>Úloha</span>
        <select value={manifestRole} onChange={(event) => setManifestRole(event.target.value as Addon["role"])}>
          <option value="both">Automaticky / obojí</option><option value="catalog">Pouze knihovna</option><option value="source">Pouze zdroje</option>
        </select></label>
      <div className="manifest-actions">
        <button className="primary" disabled={manifestBusy || !manifestUrl.trim()} onClick={() => void saveManifest()}><Check/> Uložit</button>
        <button onClick={async () => { try { await navigator.clipboard.writeText(manifestUrl); onNotify("Adresa zkopírována."); } catch (error) { onError(error); } }}><Copy/> Kopírovat URL</button>
        <button onClick={() => void exportManifest()}><FileJson/> Exportovat JSON</button>
      </div>
    </div>}
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
  return <section><div className="download-title"><Heading eyebrow="STAHOVÁNÍ" title="Fronta"/><button disabled={!jobs.some((job) => job.status === "completed")} onClick={() => action(api.clearCompleted)}><Trash2/> Vyčistit dokončené</button></div><div className="summary"><div><b>{jobs.length}</b><span>položek</span></div><div><b>{active.length}</b><span>probíhá</span></div><div><b>{speed(totalSpeed)}</b><span>celková rychlost</span></div></div><div className="panel downloads"><div className="download-head"><span>Název</span><span>Stav</span><span>Průběh</span><span>Rychlost / zbývá</span><span>Akce</span></div>{jobs.map((job)=><div className="download-row" key={job.id}><div><strong>{job.title}</strong><small>{job.target || (job.pending ? "Zdroj se vybere při stahování" : "")}{job.error ? ` · ${job.error}`:""}</small></div><span className={`job-status ${job.status}`}>{statusLabel(job.status)}</span><div><span>{bytes(job.received)} / {bytes(job.total)}</span><div className="progress"><i style={{width:`${job.total ? Math.min(100, job.received/job.total*100):0}%`}}/></div></div><span>{speed(job.speed)}<small>{eta(job)}</small></span><div className="queue-actions"><button title="Nahoru" disabled={job.order === 0 || job.status === "downloading"} onClick={() => action(() => api.moveDownload(job.id, -1))}><ArrowUp/></button><button title="Dolů" disabled={job.order === jobs.length - 1 || job.status === "downloading"} onClick={() => action(() => api.moveDownload(job.id, 1))}><ArrowDown/></button>{job.status === "downloading" || job.status === "queued" ? <button title="Pozastavit" onClick={() => action(() => api.downloadAction(job.id,"pause"))}><Pause/></button> : job.status === "paused" ? <button title="Pokračovat" onClick={() => action(() => api.downloadAction(job.id,"resume"))}><Play/></button> : job.status === "failed" ? <button title="Zkusit znovu" onClick={() => action(() => api.downloadAction(job.id,"retry"))}><RefreshCw/></button> : null}<button className="danger" title="Odstranit z fronty" onClick={() => action(() => api.removeDownload(job.id))}><Trash2/></button></div></div>)}{!jobs.length && <Empty icon={<Download/>} title="Fronta je prázdná" text="Vyberte přímý HTTP stream a použijte tlačítko Stáhnout."/>}</div></section>;
}
const fmtEta = (seconds: number) => seconds < 60 ? `${Math.ceil(seconds)} s` : seconds < 3600 ? `${Math.ceil(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.ceil((seconds % 3600) / 60)} min`;
const statusLabel = (status: DownloadJob["status"]) => ({ queued: "Ve frontě", downloading: "Stahuji", paused: "Pozastaveno", completed: "Dokončeno", failed: "Chyba" })[status];
