import { useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp, FolderOpen, HardDrive, X } from "lucide-react";
import { api, describeError } from "./api";
import { t, useI18n } from "./i18n";
import type { LibraryFolder } from "./types";

const parentOf = (folder: string) => folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";

/** Picks the folder an item moves into. It opens where the item sits now, so the usual move --
 *  one level up or into the folder next door -- is a couple of clicks away. */
export function MoveDialog({ path, label, onClose, onMoved }:
  { path: string; label: string; onClose: () => void; onMoved: (target: string) => void }) {
  useI18n();
  const [folder, setFolder] = useState(parentOf(path));
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
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
    void api.libraryFolders(folder)
      .then((result) => { if (!cancelled) { setFolders(result.folders); setError(""); } })
      .catch((value) => { if (!cancelled) setError(describeError(value)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [folder]);

  // The item cannot land where it already is, and a folder cannot be moved inside itself.
  const inItself = folder === path || folder.startsWith(`${path}/`);
  const unchanged = folder === parentOf(path);
  const crumbs = folder ? folder.split("/") : [];

  const move = async () => {
    setBusy(true);
    try {
      const result = await api.moveLibraryItem(path, folder);
      onMoved(result.path);
    } catch (value) { setError(describeError(value)); setBusy(false); }
  };

  return <div className="identify-overlay" role="dialog" aria-modal="true" aria-label={t("library.move")}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="panel identify-card move-card">
      <div className="identify-head">
        <h2>{t("library.moveTitle", { name: label })}</h2>
        <button type="button" className="icon-button" aria-label={t("common.cancel")} onClick={onClose}><X/></button>
      </div>
      <nav className="move-crumbs" aria-label={t("library.moveDestination")}>
        <button type="button" onClick={() => setFolder("")}><HardDrive/> {t("library.rootFolder")}</button>
        {crumbs.map((name, index) => <span key={name + index}>
          <ChevronRight aria-hidden="true"/>
          <button type="button" onClick={() => setFolder(crumbs.slice(0, index + 1).join("/"))}>{name}</button>
        </span>)}
      </nav>
      <div className="move-list">
        {folder && <button type="button" className="move-up" onClick={() => setFolder(parentOf(folder))}>
          <CornerLeftUp/> {t("library.moveUp")}
        </button>}
        {folders.map((item) => <button type="button" key={item.path} disabled={item.path === path} onClick={() => setFolder(item.path)}>
          <FolderOpen/> <span>{item.name}</span> <ChevronRight/>
        </button>)}
        {!busy && !folders.length && <p className="identify-hint">{t("library.moveNoSubfolders")}</p>}
      </div>
      {error && <p className="login-error">{error}</p>}
      <p className="identify-hint">{inItself
        ? t("library.moveIntoItself")
        : unchanged ? t("library.moveSameFolder") : t("library.moveTargetHint", { folder: folder || t("library.rootFolder") })}</p>
      <button type="button" className="primary" disabled={busy || inItself || unchanged} onClick={() => void move()}>
        {t("library.moveConfirm")}
      </button>
    </div>
  </div>;
}
