import { useEffect, useState } from "react";
import { Check, Sparkles, X } from "lucide-react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import type { SuggestionRow } from "./types";

/** What the scan proposed but did not dare bind on its own. */
export function SuggestionsDialog(
  { onClose, onChanged, onIdentify }: { onClose: () => void; onChanged: () => void; onIdentify: (path: string) => void },
) {
  useI18n();
  const [rows, setRows] = useState<SuggestionRow[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void api.librarySuggestions()
      .then((result) => { if (!cancelled) setRows(result.items); })
      .catch((value) => { if (!cancelled) { setError(describeError(value)); setRows([]); } });
    return () => { cancelled = true; };
  }, []);

  const act = async (row: SuggestionRow, confirm: boolean) => {
    setBusy(row.key); setError("");
    try {
      if (confirm) await api.matchLibraryItem({ path: row.key, id: row.suggestion.id, type: row.suggestion.type });
      else await api.dismissLibrarySuggestion(row.key);
      setRows((current) => (current ?? []).filter((item) => item.key !== row.key));
      onChanged();
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(""); }
  };

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.suggestions")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card">
      <div className="identify-head">
        <h2>{t("library.suggestions")}</h2>
        <button type="button" className="icon-button" aria-label={t("common.cancel")} onClick={onClose}><X/></button>
      </div>
      {error && <p className="login-error">{error}</p>}
      {!rows && <p className="identify-hint">{t("common.loading")}</p>}
      {rows && !rows.length && <p className="identify-hint">{t("library.suggestionsEmpty")}</p>}
      {rows && rows.length > 0 && <>
        <p className="identify-hint">{t("library.suggestionsLead")}</p>
        <div className="suggestion-list">
          {rows.map((row) => <article key={row.key} className="suggestion-row">
            <div className="suggestion-copy">
              <strong>{row.label}</strong>
              <small>{[row.suggestion.name, row.suggestion.year, t("library.suggestionScore", { score: row.suggestion.score })].filter(Boolean).join(" · ")}</small>
            </div>
            <div className="suggestion-actions">
              <button type="button" className="primary" disabled={busy === row.key} onClick={() => void act(row, true)}><Check/> {t("library.suggestionConfirm")}</button>
              <button type="button" disabled={busy === row.key} onClick={() => onIdentify(row.key)}><Sparkles/> {t("library.identify")}</button>
              <button type="button" disabled={busy === row.key} onClick={() => void act(row, false)}><X/> {t("library.suggestionDismiss")}</button>
            </div>
          </article>)}
        </div>
      </>}
    </div>
  </div>;
}
