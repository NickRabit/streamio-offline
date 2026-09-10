import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Download, X } from "lucide-react";
import { api, describeError } from "./api";
import { languageName, t, useI18n } from "./i18n";
import type { DownloadSelection, DownloadSourceStrategy, SubtitleMode } from "./types";

interface Episode { id: string; season?: number; episode?: number; title?: string }

export function SeriesDownloadDialog({ type, label, episodes, audioLanguage, subtitleLanguage, languages, onClose, onSubmit }: {
  type: string;
  label: string;
  episodes: Episode[];
  audioLanguage: string;
  subtitleLanguage: string;
  languages: Array<{ code: string; name: string }>;
  onClose: () => void;
  onSubmit: (selection: DownloadSelection) => Promise<void>;
}) {
  useI18n();
  const [sources, setSources] = useState<Array<{ key: string; name: string }>>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [sourceStrategy, setSourceStrategy] = useState<DownloadSourceStrategy>("largest");
  const [audio, setAudio] = useState(audioLanguage);
  const [audioFallback, setAudioFallback] = useState(audioLanguage === "en" ? "" : "en");
  const [subtitleMode, setSubtitleMode] = useState<SubtitleMode>("optional");
  const [subtitle, setSubtitle] = useState(subtitleLanguage);
  const [subtitleFallback, setSubtitleFallback] = useState(subtitleLanguage === "en" ? "" : "en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    let cancelled = false;
    const first = episodes[0];
    if (!first) return;
    api.streamSources(type, first.id).then((items) => {
      if (cancelled) return;
      setSources(items); setChosen(items.map((item) => item.key));
    }).catch((value) => { if (!cancelled) setError(describeError(value)); });
    return () => { cancelled = true; };
  }, [type, episodes]);

  const toggle = (key: string) => setChosen((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const move = (key: string, direction: -1 | 1) => setChosen((current) => {
    const index = current.indexOf(key); const next = index + direction;
    if (index < 0 || next < 0 || next >= current.length) return current;
    const copy = [...current]; [copy[index], copy[next]] = [copy[next], copy[index]]; return copy;
  });
  const orderedSources = [...sources].sort((a, b) => {
    const left = chosen.indexOf(a.key), right = chosen.indexOf(b.key);
    if (left < 0 || right < 0) return left < 0 ? 1 : -1;
    return left - right;
  });
  const languageOptions = () => languages.map(({ code }) => <option key={code} value={code}>{languageName(code)}</option>);

  const submit = async () => {
    if (!chosen.length) return;
    setBusy(true); setError("");
    try {
      await onSubmit({
        addonKeys: chosen, sourceStrategy, audioLanguage: audio,
        fallbackAudioLanguage: audioFallback && audioFallback !== audio ? audioFallback : undefined,
        subtitleMode,
        subtitleLanguage: subtitleMode === "off" ? undefined : subtitle,
        fallbackSubtitleLanguage: subtitleMode !== "off" && subtitleFallback !== subtitle ? subtitleFallback || undefined : undefined,
      });
      onClose();
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("bulk.title")} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="panel identify-card bulk-card">
      <div className="identify-head"><div><h2>{t("bulk.title")}</h2><p className="identify-hint">{label} · {t("bulk.episodeCount", { count: episodes.length })}</p></div><button className="icon-button" aria-label={t("common.cancel")} disabled={busy} onClick={onClose}><X/></button></div>
      <div className="bulk-strategy">
        <label><span>{t("bulk.sourceStrategy")}</span><select value={sourceStrategy} onChange={(event) => setSourceStrategy(event.target.value as DownloadSourceStrategy)}><option value="largest">{t("bulk.strategyLargest")}</option><option value="priority">{t("bulk.strategyPriority")}</option></select></label>
        <p className="identify-hint">{t(sourceStrategy === "largest" ? "bulk.strategyLargestHint" : "bulk.strategyPriorityHint")}</p>
      </div>
      <fieldset className="bulk-sources"><legend>{t("bulk.sources")}</legend><p className="identify-hint">{t("bulk.sourcesHint")}</p>
        {orderedSources.map((source) => { const index = chosen.indexOf(source.key); return <div key={source.key} className={index >= 0 ? "selected" : ""}>
          <label><input type="checkbox" checked={index >= 0} onChange={() => toggle(source.key)}/><span>{source.name}</span></label>
          {index >= 0 && sourceStrategy === "priority" && <span><button className="icon-button" aria-label={t("bulk.moveSourceUp", { name: source.name })} disabled={index === 0} onClick={() => move(source.key, -1)}><ArrowUp/></button><button className="icon-button" aria-label={t("bulk.moveSourceDown", { name: source.name })} disabled={index === chosen.length - 1} onClick={() => move(source.key, 1)}><ArrowDown/></button></span>}
        </div>})}
        {!sources.length && !error && <p className="identify-hint">{t("common.loading")}</p>}
      </fieldset>
      <div className="bulk-language-grid">
        <label><span>{t("bulk.audio")}</span><select value={audio} onChange={(event) => setAudio(event.target.value)}>{languageOptions()}</select></label>
        <label><span>{t("bulk.audioFallback")}</span><select value={audioFallback} onChange={(event) => setAudioFallback(event.target.value)}><option value="">{t("bulk.noFallback")}</option>{languageOptions()}</select></label>
        <label><span>{t("bulk.subtitles")}</span><select value={subtitleMode} onChange={(event) => setSubtitleMode(event.target.value as SubtitleMode)}><option value="off">{t("bulk.subtitlesOff")}</option><option value="optional">{t("bulk.subtitlesOptional")}</option><option value="required">{t("bulk.subtitlesRequired")}</option></select></label>
        <label><span>{t("bulk.subtitleLanguage")}</span><select disabled={subtitleMode === "off"} value={subtitle} onChange={(event) => setSubtitle(event.target.value)}>{languageOptions()}</select></label>
        <label><span>{t("bulk.subtitleFallback")}</span><select disabled={subtitleMode === "off"} value={subtitleFallback} onChange={(event) => setSubtitleFallback(event.target.value)}><option value="">{t("bulk.noFallback")}</option>{languageOptions()}</select></label>
      </div>
      {subtitleMode === "optional" && <p className="identify-hint bulk-subtitle-hint">{t("bulk.subtitlePriorityHint")}</p>}
      <p className="identify-hint">{t("bulk.queueHint")}</p>
      {error && <p className="login-error">{error}</p>}
      <button className="primary" disabled={busy || !chosen.length || !sources.length} onClick={() => void submit()}><Download/> {busy ? t("save.adding") : t("bulk.add")}</button>
    </div>
  </div>;
}
