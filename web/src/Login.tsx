import { FormEvent, useState } from "react";
import { CirclePlay, KeyRound, LogOut, ShieldAlert } from "lucide-react";
import { api } from "./api";
import type { Session } from "./types";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function LoginScreen({ session, onSession }: { session: Session | null; onSession: (session: Session) => void }) {
  const forced = Boolean(session?.mustChangePassword);
  const [username, setUsername] = useState(session?.username ?? "");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(""); setBusy(true);
    try {
      if (forced) {
        if (password.length < 6) throw new Error("Nové heslo musí mít aspoň 6 znaků.");
        if (password !== repeat) throw new Error("Hesla se neshodují.");
        onSession(await api.changeCredentials({ username: username.trim(), newPassword: password }));
      } else {
        onSession(await api.login(username.trim(), password, remember));
      }
    } catch (value) { setError(message(value)); }
    finally { setBusy(false); }
  };

  return <div className="login-screen">
    <form className="panel login-card" onSubmit={submit}>
      <div className="login-brand"><div className="brand-mark"><CirclePlay/></div><div><small>DOMÁCÍ MEDIATÉKA</small><h1>Stremio <span>Offline</span></h1></div></div>

      {forced
        ? <p className="login-warning"><ShieldAlert/> Účet zatím používá výchozí heslo. Než půjdeme dál, nastavte si prosím vlastní.</p>
        : <p className="login-lead">Přihlaste se ke svému serveru.</p>}

      <label><span>Uživatelské jméno</span>
        <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus={!forced} required/></label>

      <label><span>{forced ? "Nové heslo" : "Heslo"}</span>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)}
          autoComplete={forced ? "new-password" : "current-password"} autoFocus={forced} required/></label>

      {forced && <label><span>Nové heslo znovu</span>
        <input type="password" value={repeat} onChange={(event) => setRepeat(event.target.value)} autoComplete="new-password" required/></label>}

      {!forced && <label className="login-remember">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)}/>
        <span>Zapamatovat přihlášení na tomto zařízení (30 dní)</span></label>}

      {error && <p className="login-error">{error}</p>}
      <button className="primary" disabled={busy}><KeyRound/> {forced ? "Nastavit heslo" : "Přihlásit se"}</button>
    </form>
  </div>;
}

export function AccountSettings({ session, onSession, onNotify, onError }: {
  session: Session; onSession: (session: Session) => void;
  onNotify: (text: string) => void; onError: (error: unknown) => void;
}) {
  const [username, setUsername] = useState(session.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 6) return onError(new Error("Nové heslo musí mít aspoň 6 znaků."));
    setBusy(true);
    try {
      onSession(await api.changeCredentials({ username: username.trim(), currentPassword, newPassword }));
      setCurrentPassword(""); setNewPassword("");
      onNotify("Údaje změněny, ostatní zařízení byla odhlášena.");
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  return <div className="panel settings-card account-card">
    <h3>Přihlášení</h3>
    <p>Přihlášen jako <strong>{session.username}</strong>. Změna údajů odhlásí všechna ostatní zařízení.</p>
    <form className="account-form" onSubmit={submit}>
      <label><span>Uživatelské jméno</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required/></label>
      <label><span>Stávající heslo</span><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required/></label>
      <label><span>Nové heslo</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required/></label>
      <button className="primary" disabled={busy}><KeyRound/> Změnit údaje</button>
    </form>
    <div className="log-actions">
      <button onClick={async () => { try { await api.logout(); } finally { location.reload(); } }}><LogOut/> Odhlásit se</button>
      <button className="danger" onClick={async () => {
        if (!confirm("Odhlásit i všechna ostatní zařízení? Uložená přihlášení v jiných prohlížečích přestanou platit.")) return;
        try { await api.logout(true); } finally { location.reload(); }
      }}><ShieldAlert/> Odhlásit všude</button>
    </div>
    <small>Odhlášení zneplatní relaci i na serveru, takže zachycená cookie už dovnitř nepustí. Záložní údaje z proměnných ADMIN_USERNAME a ADMIN_PASSWORD platí souběžně a tímto formulářem se nemění.</small>
  </div>;
}
