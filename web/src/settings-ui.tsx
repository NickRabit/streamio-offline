import type { ReactNode } from "react";

/** Sdílené se stránkou nastavení i s kartou přihlášení, ať mají stejný vzhled. */
export function SettingsSectionHead({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="settings-section-head"><i>{icon}</i><span><strong>{title}</strong><small>{text}</small></span></div>;
}

export function SettingControl({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return <label className="setting-control"><span><strong>{title}</strong><small>{text}</small></span>{children}</label>;
}
