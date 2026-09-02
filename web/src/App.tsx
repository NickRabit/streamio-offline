import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, FolderOpen, LayoutGrid, List, MoreVertical, PanelLeftClose, PanelLeftOpen, Pencil, RotateCcw, Star, FileJson, Link2, LogOut, ChevronDown, ChevronRight, CirclePlay, Download, FileText, Film, FolderCog, HardDrive, Library, PackagePlus, Pause, Play, Plus, RefreshCw, Search, Settings, Subtitles, Trash2, X } from "lucide-react";
import { api, ApiError } from "./api";
import { AccountSettings, LoginScreen } from "./Login";
import { SettingControl, SettingsSectionHead } from "./settings-ui";
import { Player } from "./Player";
import { guessLanguages, label } from "./languages";
import { arrangeStreams, streamLanguages, streamSize, type StreamSort } from "./streams";
import type { Addon, BrowseResult, LibrarySort, ProgressEntry, WatchlistEntry, AddonDownloadSettings, Catalog, Download as DownloadJob, Inspection, Meta, Session, Settings as AppSettings, Stream, Subtitle, Video } from "./types";

type View = "catalog" | "library" | "downloads" | "addons" | "settings";
const bytes = (value?: number) => !value ? "—" : value > 1e9 ? `${(value / 1e9).toFixed(1)} GB` : value > 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${Math.round(value / 1e3)} kB`;
const speed = (value: number) => value ? `${bytes(value)}/s` : "—";
const streamLabel = (item: Stream) => item.name || item.title?.split("\n")[0] || item.description?.split("\n")[0] || (item.infoHash ? "Torrent" : "Stream");

export function App() {
  const [view, setView] = useState<View>("catalog"); const [addons, setAddons] = useState<Addon[]>([]); const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("sidebar-collapsed") === "1"; } catch { return false; }
  });
  const [catalogReset, setCatalogReset] = useState(0);
  const [selectedCatalog, setSelectedCatalog] = useState(""); const [search, setSearch] = useState(""); const [items, setItems] = useState<Meta[]>([]); const [selected, setSelected] = useState<Meta | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null); const [streams, setStreams] = useState<Stream[]>([]); const [selectedStream, setSelectedStream] = useState<Stream | null>(null); const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [episodesOpen, setEpisodesOpen] = useState(true);
  const [season, setSeason] = useState<number | null>(null);
  const [downloads, setDownloads] = useState<DownloadJob[]>([]); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [playerOpen, setPlayerOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({ concurrentDownloads: 1, audioLanguage: "cs", subtitleLanguage: "cs", mergeByName: true, streamSort: "recommended", artworkLocation: "data", trackProgress: true, showResumeRow: true });
  const [languages, setLanguages] = useState<Array<{ code: string; name: string }>>([]);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [browsePath, setBrowsePath] = useState(""); const [browseQuery, setBrowseQuery] = useState("");
  const [browseSort, setBrowseSort] = useState<LibrarySort>("name"); const [browseDesc, setBrowseDesc] = useState(false);
  const [browseView, setBrowseView] = useState<"grid" | "list">("grid");
  const [browseBusy, setBrowseBusy] = useState(false);
  const browseSeed = useRef(String(Date.now()));
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  // Odkud se do složky přišlo, aby drobečky nezahodily krok přes Oblíbené.
  const [fromFavorites, setFromFavorites] = useState(false);
  const [resume, setResume] = useState<ProgressEntry[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [libraryFavorites, setLibraryFavorites] = useState<string[]>([]);
  const [localPoster, setLocalPoster] = useState<string | undefined>(undefined);

  const removeItem = async (itemPath: string, label: string, folder: boolean) => {
    setMenuFor(null);
    if (!confirm(`Opravdu smazat ${folder ? "složku" : "soubor"} „${label}“?${folder ? " Smaže se i vše uvnitř." : ""} Tohle nejde vrátit.`)) return;
    try { await api.deleteLibraryItem(itemPath); notify("Smazáno."); await loadBrowse(browsePath); } catch (error) { fail(error); }
  };
  const toggleFavorite = async (itemPath: string, favorite: boolean) => {
    setMenuFor(null);
    try { await api.setFavorite(itemPath, favorite); await loadBrowse(browsePath); } catch (error) { fail(error); }
  };
  const inWatchlist = (type?: string, id?: string) => Boolean(id && watchlist.some((item) => item.key === `${type ?? "movie"}:${id}`));
  const toggleWatchlist = async (item: Meta) => {
    const favorite = !inWatchlist(item.type, item.id);
    try {
      await api.setWatchlist({ type: item.type || "movie", id: item.id, name: item.name, poster: item.poster, favorite });
      setWatchlist(await api.watchlist());
      notify(favorite ? "Přidáno do seznamu." : "Odebráno ze seznamu.");
    } catch (error) { fail(error); }
  };
  /** Hvězdička v přehrávači míří tam, kam patří: soubor do knihovny, titul do seznamu. */
  const togglePlayerFavorite = async () => {
    const path = localStream?.url?.slice(7);
    if (path) {
      const wanted = !libraryFavorites.includes(path);
      try {
        await api.setFavorite(path, wanted);
        setLibraryFavorites((current) => wanted ? [...current, path] : current.filter((item) => item !== path));
        notify(wanted ? "Přidáno do oblíbených." : "Odebráno z oblíbených.");
      } catch (error) { fail(error); }
      return;
    }
    if (selected) await toggleWatchlist(selected);
  };

  /** Otevře titul z katalogu; rozkoukaná pozice se pak navazuje sama podle klíče. */
  const openFromCatalog = async (entry: { type: string; id: string; name: string; poster?: string }) => {
    setView("catalog");
    await openMeta({ id: entry.id, type: entry.type, name: entry.name, poster: entry.poster } as Meta);
  };

  const forgetWatched = async (itemPath: string) => {
    setMenuFor(null);
    try { await api.forgetProgress(`file:${itemPath}`); await loadBrowse(browsePath); setResume(await api.progressList()); }
    catch (error) { fail(error); }
  };
  const renameItem = async (itemPath: string, label: string) => {
    setMenuFor(null);
    const wanted = prompt("Nové jméno:", label);
    if (!wanted || wanted === label) return;
    try { await api.renameLibraryItem(itemPath, wanted); notify("Přejmenováno."); await loadBrowse(browsePath); } catch (error) { fail(error); }
  };
  const [localStream, setLocalStream] = useState<Stream | null>(null); const [localTitle, setLocalTitle] = useState("");
  const [streamAddon, setStreamAddon] = useState(""); const [streamLanguage, setStreamLanguage] = useState(""); const [streamSort, setStreamSort] = useState<StreamSort>("recommended");
  useEffect(() => { setStreamSort(settings.streamSort as StreamSort); }, [settings.streamSort]);
  const [submittedQuery, setSubmittedQuery] = useState(""); const [searchAddon, setSearchAddon] = useState(""); const [searchable, setSearchable] = useState<Array<{ addonKey: string; addonName: string }>>([]); const [typeFilter, setTypeFilter] = useState(""); const [genre, setGenre] = useState(""); const [sort, setSort] = useState("default");
  const [skip, setSkip] = useState(0); const [cursor, setCursor] = useState(""); const [hasMore, setHasMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false); const [sourceCount, setSourceCount] = useState(0);
  const [pendingSources, setPendingSources] = useState(0);
  const pickedRef = useRef(false); const sourcesRequestRef = useRef(0);
  const loadingRef = useRef(false); const requestRef = useRef(0); const itemsRef = useRef<Meta[]>([]); const gridRef = useRef<HTMLDivElement>(null);
  // Vlastní seznamy se tváří jako katalog, jen nepocházejí od doplňku.
  const VIRTUAL = { resume: ":resume", watchlist: ":watchlist" } as const;
  const virtualCatalog = selectedCatalog === VIRTUAL.resume || selectedCatalog === VIRTUAL.watchlist ? selectedCatalog : "";
  const currentCatalog = virtualCatalog ? undefined
    : catalogs.find((catalog) => `${catalog.addonKey}:${catalog.type}:${catalog.id}` === selectedCatalog) ?? catalogs[0];
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

  const resetCatalog = () => {
    const firstCatalog = catalogs[0];
    setView("catalog");
    setSearch(""); setSubmittedQuery(""); setSearchAddon(""); setTypeFilter(""); setGenre(""); setSort("default");
    setSelectedCatalog(firstCatalog ? `${firstCatalog.addonKey}:${firstCatalog.type}:${firstCatalog.id}` : "");
    setSelected(null); setSelectedVideo(null); setStreams([]); setSelectedStream(null); setSubtitles([]); setSourcesLoaded(false);
    setStreamAddon(""); setStreamLanguage(""); setStreamSort(settings.streamSort as StreamSort);
    setEpisodesOpen(true); setSeason(null); setCatalogReset((value) => value + 1);
  };
  const toggleSidebar = () => setSidebarCollapsed((current) => {
    const next = !current;
    try { localStorage.setItem("sidebar-collapsed", next ? "1" : "0"); } catch { /* soukromý režim může úložiště zakázat */ }
    return next;
  });

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
  const loadBrowse = async (target = browsePath, skip = 0) => {
    setBrowseBusy(true);
    try {
      const options = { skip, limit: 60, sort: browseSort, order: browseDesc ? "desc" : "asc", seed: browseSeed.current };
      // Virtuální složka sbírá oblíbené z celého stromu, běžné procházení jen filtruje aktuální úroveň.
      const page = target === ":favorites"
        ? await api.favorites(options)
        : await api.browse({ ...options, path: target, query: browseQuery, favorites: onlyFavorites });
      setBrowse((previous) => skip && previous ? { ...page, items: [...previous.items, ...page.items] } : page);
    } catch (error) { fail(error); }
    finally { setBrowseBusy(false); }
  };
  const refreshBrowse = async (limit: number) => {
    try {
      const options = { limit: Math.max(60, limit), sort: browseSort, order: browseDesc ? "desc" : "asc", seed: browseSeed.current };
      const page = browsePath === ":favorites"
        ? await api.favorites(options)
        : await api.browse({ ...options, path: browsePath, query: browseQuery, favorites: onlyFavorites });
      setBrowse(page);
    } catch { /* obnovení náhledů není kritické */ }
  };
  useEffect(() => { if (!ready) return; api.watchlist().then(setWatchlist).catch(() => undefined); }, [ready, view]);
  useEffect(() => {
    if (!browse) return;
    // Příznak oblíbenosti nese každá položka výpisu, stačí ho posbírat.
    setLibraryFavorites((current) => {
      const next = new Set(current);
      for (const item of browse.items) { if (item.favorite) next.add(item.path); else next.delete(item.path); }
      return [...next];
    });
  }, [browse]);
  useEffect(() => {
    if (!ready) return;
    // Po zavření přehrávače se poslední pozice teprve odesílá, takže si chvíli počkáme.
    // Seznam potřebuje katalog i knihovna, výpis složky jen knihovna.
    const timer = setTimeout(() => {
      api.progressList().then(setResume).catch(() => undefined);
      if (!playerOpen && view === "library") void refreshBrowse(browse?.items.length ?? 60);
    }, playerOpen ? 0 : 900);
    return () => clearTimeout(timer);
  }, [ready, view, playerOpen]);
  useEffect(() => { if (!ready || view !== "library") return; void loadBrowse(browsePath); },
    [ready, view, browsePath, browseQuery, browseSort, browseDesc, onlyFavorites]);
  // Donačítání scrollem stránky, stejně jako v katalogu. Tlačítko zůstává jako záloha.
  useEffect(() => {
    if (view !== "library" || !browse) return;
    const nactenych = browse.items.length;
    if (nactenych >= browse.total) return;
    const onScroll = () => {
      if (browseBusy) return;
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) void loadBrowse(browsePath, nactenych);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [view, browse, browseBusy, browsePath]);

  // Náhledy se dodělávají na pozadí; jakmile jsou hotové, stránka se sama obnoví.
  useEffect(() => {
    if (view !== "library" || !browse?.pending) return;
    // Obnovujeme jen tolik položek, kolik už je načtených, ať se seznam nesroluje zpátky.
    const nactenych = browse.items.length;
    const timer = setTimeout(() => void refreshBrowse(nactenych), 4000);
    return () => clearTimeout(timer);
  }, [view, browse?.pending, browsePath, browseQuery, browseSort, browseDesc, onlyFavorites]);

  /** Stažený soubor se přehrává stejnou cestou jako stream, jen zdrojem je disk. */
  const playLocal = (title: string, path: string, poster?: string) => {
    setLocalPoster(poster);
    setLocalTitle(title);
    setLocalStream({ url: `file://${path}`, behaviorHints: { filename: path.split("/").pop() } });
    setPlayerOpen(true);
  };
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
    if (!submittedQuery && !virtualCatalog && !currentCatalog) return;
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
      } else if (virtualCatalog) {
        // Obsah se plní odvozeně, tady není co načítat.
        setHasMore(false);
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
    [submittedQuery, searchAddon, typeFilter, activeGenre, virtualCatalog, currentCatalog?.addonKey, currentCatalog?.type, currentCatalog?.id, catalogReset]);

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

  /** Obsah vlastních seznamů se počítá z paměti; nesmí procházet plným načtením,
   *  které by shodilo vybraný titul. */
  const virtualItems = useMemo<Meta[]>(() => {
    if (virtualCatalog === VIRTUAL.watchlist) return watchlist.map((item) => ({ id: item.id, type: item.type, name: item.name, poster: item.poster }));
    if (virtualCatalog === VIRTUAL.resume) return resume.filter((item) => !item.key.startsWith("file:")).map((item) => {
      const [type, ...rest] = item.key.split(":");
      return { id: rest.join(":"), type, name: item.title, poster: item.poster };
    });
    return [];
  }, [virtualCatalog, watchlist, resume]);
  useEffect(() => {
    if (!virtualCatalog) return;
    itemsRef.current = virtualItems; setItems(virtualItems); setHasMore(false);
  }, [virtualCatalog, virtualItems]);

  /** Pozice a hvězdička pro titul z katalogu; obojí se klíčuje stejně. */
  // Knihovna ukazuje jen to, co na disku opravdu leží; tituly z katalogu patří do katalogu.
  const localResume = useMemo(() => resume.filter((item) => item.key.startsWith("file:") && item.path), [resume]);
  const catalogProgress = (item: Meta) => resume.find((entry) => entry.key === `${item.type || "movie"}:${item.id}`);
  const forgetCatalogWatched = async (item: Meta) => {
    setMenuFor(null);
    try { await api.forgetProgress(`${item.type || "movie"}:${item.id}`); setResume(await api.progressList()); }
    catch (error) { fail(error); }
  };

  const visibleItems = useMemo(() => {
    const year = (item: Meta) => Number(String(item.releaseInfo ?? item.year ?? "").slice(0, 4)) || 0;
    // Vlastní seznamy nesou vlastní smysluplné pořadí: naposledy sledované napřed
    // a naposledy přidané do seznamu. Obecné řazení by ho jen rozbilo.
    if (virtualCatalog) return items;
    const list = settings.mergeByName ? groupByName(items) : [...items];
    if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "cs"));
    else if (sort === "year") list.sort((a, b) => year(b) - year(a));
    return list;
  }, [items, sort, settings.mergeByName, virtualCatalog]);
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
      ? { kind: "episode", title: selected?.name, season: selectedVideo.season, episode: selectedVideo.episode, episodeTitle: selectedVideo.title || selectedVideo.name, id: selected?.id, metaType: selected?.type, poster: selected?.poster }
      : { kind: "movie", title: selected?.name, id: selected?.id, metaType: selected?.type, poster: selected?.poster };
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
      const metaType = selected.type || currentCatalog?.type || "series";
      const result = await api.downloadBulk(selected.name, metaType, episodes.map((video) => ({ id: String(video.id), season: video.season, episode: video.episode, title: video.title || video.name })),
        { id: selected.id, metaType, poster: selected.poster });
      notify(`Do fronty přidáno ${result.added} epizod${result.skipped ? `, ${result.skipped} přeskočeno (už ve frontě)` : ""}.`);
      await loadDownloads();
    } catch (e) { fail(e); }
  };

  if (session === undefined) return <div className="login-screen"><div className="loading">Načítám…</div></div>;
  if (!ready) return <LoginScreen session={session} onSession={setSession}/>;

  return <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <header className="topbar"><button className="brand brand-home" title="Přejít do čistého katalogu" aria-label="Přejít do čistého katalogu" onClick={resetCatalog}><div className="brand-mark"><CirclePlay/></div><div><small>DOMÁCÍ MEDIATÉKA</small><h1>Stremio <span>Offline</span></h1></div></button><div className="topbar-right"><div className="online"><i/> Docker server online</div>
      <button className="signout" title={`Přihlášen jako ${session?.username ?? ""}`} onClick={async () => { try { await api.logout(); } finally { location.reload(); } }}><LogOut/> Odhlásit</button></div></header>
    <aside className="sidebar"><nav>
      <Nav icon={<Library/>} label="Katalog" active={view === "catalog"} onClick={() => setView("catalog")}/>
      <Nav icon={<HardDrive/>} label="Knihovna" active={view === "library"} onClick={() => setView("library")}/>
      <Nav icon={<Download/>} label="Stahování" active={view === "downloads"} badge={downloads.filter((d) => d.status === "downloading" || d.status === "queued").length} onClick={() => setView("downloads")}/>
      <Nav icon={<PackagePlus/>} label="Doplňky" active={view === "addons"} badge={addons.length} onClick={() => setView("addons")}/>
      <Nav icon={<Settings/>} label="Nastavení" active={view === "settings"} onClick={() => setView("settings")}/>
    </nav><div className="sidebar-bottom"><button className="sidebar-toggle" onClick={toggleSidebar} title={sidebarCollapsed ? "Rozbalit menu" : "Sbalit menu"} aria-label={sidebarCollapsed ? "Rozbalit menu" : "Sbalit menu"}>{sidebarCollapsed ? <PanelLeftOpen/> : <PanelLeftClose/>}<span>{sidebarCollapsed ? "Rozbalit menu" : "Sbalit menu"}</span></button><div className="addon-status"><small>AKTIVNÍ DOPLŇKY</small><strong>{addons.filter((a) => a.enabled).length}</strong><span>katalogy a zdroje</span></div></div></aside>
    <main className={view === "catalog" ? "view-catalog" : ""}>
      {view === "catalog" && <section className="catalog-view"><Heading eyebrow="KATALOG" title="Co chcete sledovat?"/>
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
                    <option value={VIRTUAL.watchlist}>★ Můj seznam ({watchlist.length})</option>
                    <option value={VIRTUAL.resume}>▸ Pokračovat ve sledování ({resume.filter((item) => !item.key.startsWith("file:")).length})</option>
                    {catalogs.map((catalog) => <option key={`${catalog.addonKey}:${catalog.type}:${catalog.id}`} value={`${catalog.addonKey}:${catalog.type}:${catalog.id}`}>{catalog.addonName} · {catalog.name || catalog.id} ({catalog.type === "series" ? "seriály" : catalog.type})</option>)}
                  </select></label>
                  {genreOptions.length > 0 && <label><span>Žánr</span><select value={activeGenre} onChange={(e) => setGenre(e.target.value)}><option value="">Všechny</option>{genreOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>}
                </>}
            <label><span>Řazení</span><select value={sort} onChange={(e) => setSort(e.target.value)}><option value="default">Podle doplňku</option><option value="name">Název A–Ž</option><option value="year">Rok sestupně</option></select></label>
            {sort !== "default" && <small className="filter-note">Řadí se jen už načtené položky.</small>}
          </div>
          <div className="catalog-layout"><section className="panel result-panel"><div className="panel-head"><h3>{submittedQuery ? `Hledání: ${submittedQuery}` : "Výsledky"}</h3><span>{visibleItems.length} položek{hasMore ? "+" : ""}</span></div>
            <div className="poster-grid" ref={gridRef}>
              {visibleItems.map((item) => {
                const klic = `${item.type || "movie"}:${item.id}`;
                const postup = catalogProgress(item);
                const vSeznamu = inWatchlist(item.type, item.id);
                return <button key={klic} className={`poster-card ${selected?.id === item.id ? "selected" : ""}`} onClick={() => openMeta(item)}>
                  <span className="poster-wrap">
                    {item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <div className="poster-fallback"><Film/></div>}
                    {vSeznamu && <i className="fav-mark"><Star/></i>}
                    {postup && <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(postup.position / (postup.duration || 1) * 100))}%` }}/></i>}
                    <span className="browse-menu" onClick={(event) => { event.stopPropagation(); setMenuFor(menuFor === klic ? null : klic); }}><MoreVertical/></span>
                  </span>
                  <strong>{item.name}</strong>
                  <small>{[item.releaseInfo || item.year, submittedQuery ? (item.sources ?? [item.addonName]).filter(Boolean).join(", ") : null].filter(Boolean).join(" · ") || item.type}</small>
                  {menuFor === klic && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
                    <button onClick={() => { setMenuFor(null); void toggleWatchlist(item); }}><Star/> {vSeznamu ? "Odebrat ze seznamu" : "Přidat do seznamu"}</button>
                    {postup && <button onClick={() => void forgetCatalogWatched(item)}><RotateCcw/> Označit jako neshlédnuté</button>}
                  </span>}
                </button>;
              })}
              {hasMore && <div className="load-more">{loadingMore ? <span>Načítám další…</span> : <button onClick={() => void loadPage(false)}>Načíst další</button>}</div>}
            </div>
            {!items.length && !busy && <Empty icon={<Search/>}
              title={submittedQuery ? "Nic se nenašlo" : searchRequired ? "Zadejte hledaný název" : "Katalog je prázdný"}
              text={submittedQuery ? `Žádný z ${sourceCount} prohledávaných katalogů nevrátil výsledek. Zkuste jiný výraz.` : searchRequired ? "Tento katalog vrací výsledky až po zadání hledaného výrazu." : "Zkuste vyhledávání nebo jiný katalog."}/>}
            {busy && <div className="loading">Načítám…</div>}
          </section><section className={`panel detail-panel ${sourcesLoaded && (selected?.videos?.length ? selectedVideo && !episodesOpen : true) ? "series-sources-layout" : ""}`}>{selected ? <>
            <div className={`hero ${selected.videos?.length ? "series-hero" : ""}`} style={selected.background ? { backgroundImage: `linear-gradient(90deg,#121721 25%,transparent),url(${selected.background})` } : undefined}><div className="detail-copy"><span className="pill">{selected.type === "series" ? "Seriál" : "Film"}</span>
              <button className={`watch-star ${inWatchlist(selected.type, selected.id) ? "on" : ""}`} title={inWatchlist(selected.type, selected.id) ? "Odebrat ze seznamu" : "Přidat do seznamu"}
                onClick={() => void toggleWatchlist(selected)}><Star/></button><h2>{selected.name}</h2><p className="meta-line">{[selected.releaseInfo || selected.year, ...(selected.genres || []).slice(0, 3)].filter(Boolean).join(" · ")}</p><p>{selected.description || "Bez popisu."}</p></div></div>
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
      {view === "library" && <section onClick={() => menuFor && setMenuFor(null)}><Heading eyebrow="KNIHOVNA" title="Stažené soubory"/>
        {settings.showResumeRow && !browsePath && !onlyFavorites && localResume.length > 0 && <div className="resume-row">
          <div className="subhead"><h3>Pokračovat ve sledování</h3><span>{localResume.length}</span></div>
          <div className="resume-strip">
            {localResume.slice(0, 8).map((item) => <button className="browse-item" key={item.key} onClick={() => {
              if (item.path) playLocal(item.title, item.path, item.poster);
            }}>
              <span className="browse-art">
                {item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}
                <i className="browse-play"><CirclePlay/></i>
                <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(item.position / (item.duration || 1) * 100))}%` }}/></i>
              </span>
              <strong>{item.title}</strong>
              <small>zbývá {fmtEta(Math.max(0, item.duration - item.position))}</small>
            </button>)}
          </div>
        </div>}
        <div className="panel browse-panel">
        <div className="browse-bar">
          <nav className="crumbs">
            <button onClick={() => { setFromFavorites(false); setBrowsePath(""); }} disabled={!browsePath}><HardDrive/> Knihovna</button>
            {(fromFavorites || browsePath === ":favorites") && <span>
              <ChevronRight/>
              <button disabled={browsePath === ":favorites"} onClick={() => setBrowsePath(":favorites")}>Oblíbené</button>
            </span>}
            {browsePath !== ":favorites" && browsePath.split("/").filter(Boolean).map((part, index, all) => <span key={part + index}>
              <ChevronRight/>
              <button disabled={index === all.length - 1} onClick={() => setBrowsePath(all.slice(0, index + 1).join("/"))}>{part}</button>
            </span>)}
          </nav>
          <div className="browse-tools">
            <div className="search-input"><Search/><input value={browseQuery} placeholder="Filtrovat…" onChange={(event) => setBrowseQuery(event.target.value)}/></div>
            <select aria-label="Řazení" value={browseSort} onChange={(event) => {
              const next = event.target.value as LibrarySort;
              setBrowseSort(next);
              // Nejnovější a největší dává smysl mít nahoře, názvy naopak od A.
              setBrowseDesc(next === "added" || next === "size");
            }}>
              <option value="name">Podle názvu</option><option value="added">Podle data přidání</option>
              <option value="size">Podle velikosti</option><option value="random">Náhodně</option>
            </select>
            <button title={browseDesc ? "Sestupně" : "Vzestupně"} onClick={() => setBrowseDesc((value) => !value)} disabled={browseSort === "random"}>
              {browseDesc ? <ArrowDown/> : <ArrowUp/>}
            </button>
            <button className={onlyFavorites ? "active-filter" : ""} title="Jen oblíbené" disabled={browsePath === ":favorites"}
              onClick={() => setOnlyFavorites((value) => !value)}><Star/></button>
            <button title={browseView === "grid" ? "Zobrazit po řádcích" : "Zobrazit dlaždice"} onClick={() => setBrowseView((value) => value === "grid" ? "list" : "grid")}>
              {browseView === "grid" ? <List/> : <LayoutGrid/>}
            </button>
          </div>
        </div>

        {!browse || !browse.items.length
          ? (browseBusy ? <div className="loading">Načítám…</div>
            : <Empty icon={<HardDrive/>} title={browseQuery ? "Nic neodpovídá filtru" : "Zatím nic staženého"} text={browseQuery ? "Zkuste jiný výraz." : "Dokončená stahování se tu objeví sama."}/>)
          : <>
            <div className={browseView === "grid" ? "browse-grid" : "browse-rows"}>
              {!browsePath && !onlyFavorites && <button className="browse-item folder favorites-tile" onClick={() => { setFromFavorites(false); setBrowsePath(":favorites"); }}>
                <span className="browse-art"><Star/></span><strong>Oblíbené</strong><small>napříč knihovnou</small>
              </button>}
              {browse.items.map((item) => item.kind === "folder"
                ? <button className="browse-item folder" key={item.path} onClick={() => { setBrowseQuery(""); setFromFavorites(browsePath === ":favorites" || fromFavorites); setBrowsePath(item.path); }}>
                    <span className="browse-art">{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <FolderOpen/>}<i className="browse-badge">{item.fileCount}</i>{item.favorite && <i className="fav-mark"><Star/></i>}</span>
                    <strong>{item.name}</strong><small>{bytes(item.size)}</small>
                    <span className="browse-menu" onClick={(event) => { event.stopPropagation(); setMenuFor(menuFor === item.path ? null : item.path); }}><MoreVertical/></span>
                    {menuFor === item.path && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
                      <button onClick={() => void toggleFavorite(item.path, !item.favorite)}><Star/> {item.favorite ? "Odebrat z oblíbených" : "Přidat do oblíbených"}</button>
                      <button onClick={() => void renameItem(item.path, item.name)}><Pencil/> Přejmenovat</button>
                      <button className="danger" onClick={() => void removeItem(item.path, item.name, true)}><Trash2/> Smazat</button>
                    </span>}
                  </button>
                : <button className="browse-item" key={item.path} onClick={() => playLocal(item.label, item.path, item.poster)}>
                    <span className="browse-art">{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}<i className="browse-play"><CirclePlay/></i>{item.favorite && <i className="fav-mark"><Star/></i>}
                    {item.progress && <i className="resume-bar"><i style={{ width: `${Math.min(100, Math.round(item.progress.position / (item.progress.duration || 1) * 100))}%` }}/></i>}</span>
                    <strong>{item.season != null ? `${item.season}×${String(item.episode ?? 0).padStart(2, "0")} ${item.label}` : item.label}</strong>
                    <small>{bytes(item.size)}</small>
                    <span className="browse-menu" onClick={(event) => { event.stopPropagation(); setMenuFor(menuFor === item.path ? null : item.path); }}><MoreVertical/></span>
                    {menuFor === item.path && <span className="browse-actions" onClick={(event) => event.stopPropagation()}>
                      <button onClick={() => void toggleFavorite(item.path, !item.favorite)}><Star/> {item.favorite ? "Odebrat z oblíbených" : "Přidat do oblíbených"}</button>
                      {item.progress && <button onClick={() => void forgetWatched(item.path)}><RotateCcw/> Označit jako neshlédnuté</button>}
                      <button onClick={() => void renameItem(item.path, item.label)}><Pencil/> Přejmenovat</button>
                      <button className="danger" onClick={() => void removeItem(item.path, item.label, false)}><Trash2/> Smazat</button>
                    </span>}
                  </button>)}
            </div>
            {browseBusy && <div className="loading">Načítám…</div>}
            {(() => {
              const nactenych = browse.items.length;
              return !browseBusy && nactenych < browse.total && <div className="load-more">
                <button onClick={() => void loadBrowse(browsePath, nactenych)}>Načíst další ({browse.total - nactenych})</button>
              </div>;
            })()}
          </>}
        </div>
      </section>}
      {view === "addons" && <Addons addons={addons} onChanged={refresh} onNotify={notify} onError={fail}/>} 
      {view === "downloads" && <Downloads jobs={downloads} refresh={loadDownloads} onError={fail}/>}
      {view === "settings" && <SettingsPage settings={settings} languages={languages} session={session!} onSession={setSession} onSave={saveSettings} onNotify={notify} onError={fail}/>}
    </main>
    <Player open={playerOpen} title={localStream ? localTitle : videoTitle} stream={localStream ?? selectedStream} subtitles={subtitles} subtitleLanguage={settings.subtitleLanguage}
      progressKey={localStream?.url ? `file:${localStream.url.slice(7)}` : (videoId ? `${selected?.type ?? "movie"}:${videoId}` : undefined)}
      progressPoster={localStream ? localPoster : selected?.poster}
      favorite={localStream?.url ? libraryFavorites.includes(localStream.url.slice(7)) : inWatchlist(selected?.type, selected?.id)}
      onToggleFavorite={localStream?.url || selected ? () => void togglePlayerFavorite() : undefined}
      onDownload={enqueue} onClose={() => { setPlayerOpen(false); setLocalStream(null); }}/>
    {(message || error) && <div className={`toast ${error ? "error" : ""}`}>{error || message}<button onClick={() => {setError("");setMessage("");}}><X/></button></div>}
  </div>;
}

function Nav({ icon, label, active, badge, onClick }: { icon: React.ReactNode; label: string; active: boolean; badge?: number; onClick: () => void }) { return <button className={active ? "active" : ""} title={label} aria-label={label} onClick={onClick}>{icon}<span>{label}</span>{badge != null && <b>{badge}</b>}</button>; }
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
      <section className="panel settings-section"><SettingsSectionHead icon={<Library/>} title="Knihovna" text="Zobrazení výsledků z více doplňků"/><SettingControl title="Stejné tituly" text="Shodný název a rok lze sloučit do jedné položky."><select aria-label="Stejné tituly" value={settings.mergeByName ? "1" : "0"} onChange={(event) => void onSave({ mergeByName: event.target.value === "1" })}><option value="1">Slučovat</option><option value="0">Zobrazit zvlášť</option></select></SettingControl><SettingControl title="Sledovat, kde jste skončil" text="Ukládá pozici přehrávání, aby šlo navázat. Vypnutím se nic nového nezaznamená.">
          <select aria-label="Sledovat pozici" value={settings.trackProgress ? "1" : "0"} onChange={(event) => void onSave({ trackProgress: event.target.value === "1" })}>
            <option value="1">Ukládat</option><option value="0">Neukládat</option>
          </select></SettingControl>
        <SettingControl title="Řádek Pokračovat ve sledování" text="Zobrazí rozkoukané tituly nahoře v knihovně.">
          <select aria-label="Řádek rozkoukaných" value={settings.showResumeRow ? "1" : "0"} onChange={(event) => void onSave({ showResumeRow: event.target.value === "1" })}>
            <option value="1">Zobrazovat</option><option value="0">Skrýt</option>
          </select></SettingControl>
        <SettingControl title="Historie sledování" text="Smaže všechny uložené pozice. Soubory zůstanou.">
          <button className="danger" onClick={async () => {
            if (!confirm("Opravdu smazat celou historii sledování?")) return;
            try { await api.clearProgress(); onNotify("Historie smazána."); } catch (error) { onError(error); }
          }}><Trash2/> Smazat historii</button></SettingControl>
        <SettingControl title="Kam ukládat náhledy" text="Vedle videa je převezme i Jellyfin nebo Emby, ale zapisujeme tím do vašich složek. Cizí obrázek nikdy nepřepisujeme.">
        <select aria-label="Kam ukládat náhledy" value={settings.artworkLocation} onChange={(event) => void onSave({ artworkLocation: event.target.value as "data" | "media" })}>
          <option value="data">Do dat aplikace</option><option value="media">Vedle videa</option>
        </select></SettingControl><SettingControl title="Výchozí řazení zdrojů" text="Doporučené dá dopředu preferovaný jazyk, pak doplňky s vyšší prioritou a uvnitř největší soubory."><select aria-label="Výchozí řazení zdrojů" value={settings.streamSort} onChange={(event) => void onSave({ streamSort: event.target.value })}><option value="recommended">Doporučené</option><option value="size-desc">Od největšího</option><option value="size-asc">Od nejmenšího</option><option value="addon">Podle priority doplňku</option></select></SettingControl></section>
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
