import { FormEvent, useState } from "react";
import { api, ApiError } from "../api";
import { useBrand } from "../brand";
import { BrandMark } from "../components/BrandMark";

/**
 * Shown instead of the panel while the account still uses the documented
 * default password. It talks only to /api/admin/password, which is the one
 * admin endpoint the server allows in this state.
 */
export function ForcePasswordChange({ username, isAdmin }: { username: string; isAdmin: boolean }) {
  const brand = useBrand();
  const [currentPassword, setCurrentPassword] = useState(isAdmin ? "admin" : "");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword.length < 12) {
      setError("La nuova password deve avere almeno 12 caratteri.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Le due password non coincidono.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ ok: boolean; recoveryCodes?: string[] }>("/api/admin/password", {
        currentPassword,
        newPassword,
      });
      if (res.recoveryCodes?.length) {
        setRecoveryCodes(res.recoveryCodes);
        return;
      }
      window.location.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError("Password attuale non corretta.");
      else if (err instanceof ApiError && err.status === 400) setError("Nuova password non valida (min. 12 caratteri).");
      else setError("Impossibile cambiare la password.");
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes) {
    return (
      <div className="auth-page">
        <div className="card auth-card">
          <BrandMark name={brand} size={42} />
          <h2 style={{ margin: 0, textAlign: "center" }}>Codici di recupero</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Salvali ora: vengono mostrati <b>una sola volta</b>. Se dimentichi la password, uno di questi codici ti
            permette di impostarne una nuova dal login («Password dimenticata?»).
          </p>
          <ol className="recovery-list">
            {recoveryCodes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ol>
          <button
            className="btn btn-ghost btn-small"
            type="button"
            onClick={() => void navigator.clipboard?.writeText(recoveryCodes.join("\n"))}
          >
            Copia tutti
          </button>
          <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
            Li ho salvati, continua
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <BrandMark name={brand} size={42} />
        <h2 style={{ margin: 0, textAlign: "center" }}>Cambia la password</h2>
        <p className="muted small" style={{ margin: 0, textAlign: "center" }}>
          Stai usando la password predefinita. Scegline una nuova (almeno 12 caratteri) per continuare.
        </p>

        <label className="field">
          <span>Utente</span>
          <input className="input" value={username} disabled />
        </label>
        <label className="field">
          <span>Password attuale</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Nuova password (min. 12 caratteri)</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Ripeti la nuova password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </label>

        {error && <p className="error-text">{error}</p>}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Salvataggio…" : "Salva e continua"}
        </button>
      </form>
    </div>
  );
}
