import { FormEvent, useState } from "react";
import { CirclePlay, KeyRound, Languages, LogOut, ShieldAlert } from "lucide-react";
import { api, describeError } from "./api";
import type { Session } from "./types";
import { SettingControl, SettingsSectionHead } from "./settings-ui";
import { LOCALES, LOCALE_NAMES, useI18n, type Locale } from "./i18n";

export function LoginScreen({ setup, onSession }: { setup: boolean; onSession: (session: Session) => void }) {
  const { t, locale, setLocale } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(""); setBusy(true);
    try {
      if (setup) {
        if (username.trim().length < 3) throw new Error(t("auth.usernameTooShort"));
        if (password.length < 6) throw new Error(t("auth.passwordTooShort"));
        if (password !== repeat) throw new Error(t("auth.passwordMismatch"));
        onSession(await api.setup(username.trim(), password, locale));
      } else {
        onSession(await api.login(username.trim(), password, remember));
      }
    } catch (value) { setError(describeError(value)); }
    finally { setBusy(false); }
  };

  return <div className="login-screen">
    <form className="panel login-card" onSubmit={submit}>
      <div className="login-brand"><div className="brand-mark"><CirclePlay/></div><div><small>{t("auth.brandEyebrow")}</small><h1>Stremio <span>Offline</span></h1></div></div>

      {setup
        ? <p className="login-warning"><ShieldAlert/> {t("auth.setupLead")}</p>
        : <p className="login-lead">{t("auth.signInLead")}</p>}

      {setup && <label><span><Languages/> {t("auth.language")}</span>
        <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)} aria-label={t("auth.language")}>
          {LOCALES.map((code) => <option key={code} value={code}>{LOCALE_NAMES[code]}</option>)}
        </select></label>}

      <label><span>{t("auth.username")}</span>
        <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required/></label>

      <label><span>{t("auth.password")}</span>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)}
          autoComplete={setup ? "new-password" : "current-password"} required/></label>

      {setup && <label><span>{t("auth.passwordRepeat")}</span>
        <input type="password" value={repeat} onChange={(event) => setRepeat(event.target.value)} autoComplete="new-password" required/></label>}

      {!setup && <label className="login-remember">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)}/>
        <span>{t("auth.remember")}</span></label>}

      {error && <p className="login-error">{error}</p>}
      <button className="primary" disabled={busy}><KeyRound/> {setup ? t("auth.createAccount") : t("auth.signIn")}</button>
    </form>
  </div>;
}

export function AccountSettings({ session, onSession, onNotify, onError }: {
  session: Session; onSession: (session: Session) => void;
  onNotify: (text: string) => void; onError: (error: unknown) => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState(session.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 6) return onError(new Error(t("auth.newPasswordTooShort")));
    setBusy(true);
    try {
      onSession(await api.changeCredentials({ username: username.trim(), currentPassword, newPassword }));
      setCurrentPassword(""); setNewPassword("");
      onNotify(t("auth.credentialsChanged"));
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  const signOut = async (everywhere: boolean) => {
    if (everywhere && !confirm(t("auth.signOutEverywhereConfirm"))) return;
    try { await api.logout(everywhere); } finally { location.reload(); }
  };

  return <form className="panel settings-section" onSubmit={submit}>
    <SettingsSectionHead icon={<KeyRound/>} title={t("auth.sectionTitle")} text={t("auth.signedInAs", { username: session.username })}/>
    <SettingControl title={t("auth.username")} text={t("auth.usernameHint")}>
      <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required/>
    </SettingControl>
    <SettingControl title={t("auth.currentPassword")} text={t("auth.currentPasswordHint")}>
      <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required/>
    </SettingControl>
    <SettingControl title={t("auth.newPassword")} text={t("auth.newPasswordHint")}>
      <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required/>
    </SettingControl>
    <div className="setting-actions">
      <button className="primary" disabled={busy}><KeyRound/> {t("auth.changeCredentials")}</button>
      <button type="button" onClick={() => void signOut(false)}><LogOut/> {t("auth.signOut")}</button>
      <button type="button" className="danger" onClick={() => void signOut(true)}><ShieldAlert/> {t("auth.signOutEverywhere")}</button>
    </div>
    <small className="setting-note">{t("auth.sessionNote")}</small>
  </form>;
}
