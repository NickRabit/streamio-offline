import { FormEvent, useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import type { LibraryMatch, Meta } from "./types";

const hideBroken = (event: React.SyntheticEvent<HTMLImageElement>) => event.currentTarget.classList.add("broken");

export function IdentifyDialog({ path, onClose, onApplied }: { path: string; onClose: () => void; onApplied: () => void }) {
  useI18n();
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [kind, setKind] = useState<"movie" | "series">("movie");
  const [match, setMatch] = useState<LibraryMatch>("unmatched");
  const [suggestionId, setSuggestionId] = useState<string>();
  const [items, setItems] = useState<Meta[]>([]);
  const [picked, setPicked] = useState<Meta | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void api.libraryIdentity(path).then(async (identity) => {
      if (cancelled) return;
      const nextTitle = identity.parsed.title;
      const nextKind = identity.kind === "series" ? "series" : "movie";
      setTitle(nextTitle);
      setYear(identity.parsed.year != null ? String(identity.parsed.year) : "");
      setKind(nextKind);
      setMatch(identity.match);
      setSuggestionId(identity.suggestion?.id);
      const result = await api.search(identity.parsed.query || nextTitle, nextKind);
      if (cancelled) return;
      setItems(result.items);
      const highlight = result.items.find((item) => item.id === identity.suggestion?.id) ?? result.items[0] ?? null;
      setPicked(highlight);
    }).catch((value) => { if (!cancelled) setError(describeError(value)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [path]);

  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true); setError("");
    try {
      const query = year.trim() ? `${title.trim()} ${year.trim()}` : title.trim();
      const result = await api.search(query, kind);
      setItems(result.items);
      const highlight = result.items.find((item) => item.id === suggestionId) ?? result.items[0] ?? null;
      setPicked(highlight);
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!picked) return;
    setBusy(true); setError("");
    try {
      await api.matchLibraryItem({ path, id: picked.id, type: picked.type || kind, locked: true });
      onApplied();
    } catch (value) { setError(describeError(value)); setBusy(false); }
  };

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.identify")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="panel identify-card" onSubmit={search}>
      <div className="identify-head">
        <h2>{t(match === "matched" ? "library.fixMatch" : "library.identify")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.cancel")} onClick={onClose}><X/></button>
      </div>
      {match === "rejected" && <p className="identify-hint">{t("library.unmatchedLocked")}</p>}
      <label><span>{t("library.identifyTitle")}</span><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus/></label>
      <div className="identify-row">
        <label><span>{t("library.identifyYear")}</span><input value={year} onChange={(event) => setYear(event.target.value)} inputMode="numeric"/></label>
        <fieldset className="identify-type">
          <legend>{t("library.identifyType")}</legend>
          <button type="button" className={kind === "movie" ? "primary" : ""} onClick={() => setKind("movie")}>{t("library.typeMovie")}</button>
          <button type="button" className={kind === "series" ? "primary" : ""} onClick={() => setKind("series")}>{t("library.typeSeries")}</button>
        </fieldset>
      </div>
      <button type="submit" className="primary" disabled={busy || !title.trim()}><Search/> {t("library.identifySearch")}</button>
      {error && <p className="login-error">{error}</p>}
      {busy && !items.length && <p className="identify-hint">{t("common.loading")}</p>}
      {!busy && !items.length && <p className="identify-hint">{t("library.identifyEmpty")}</p>}
      {items.length > 0 && <div className="identify-results">
        {items.map((item) => <button type="button" key={`${item.type}:${item.id}`} className={picked?.id === item.id ? "selected" : ""} onClick={() => setPicked(item)}>
          <span className="identify-poster">{item.poster ? <img src={item.poster} alt="" onError={hideBroken}/> : <span/>}</span>
          <span><strong>{item.name}</strong><small>{[item.releaseInfo || item.year, item.type].filter(Boolean).join(" · ")}</small></span>
        </button>)}
      </div>}
      <button type="button" className="primary" disabled={!picked || busy} onClick={() => void apply()}>{t("library.identifyApply")}</button>
    </form>
  </div>;
}
