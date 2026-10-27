import { FormEvent, useState } from "react";
import { api, ApiError, recoverPassword } from "../api";
import { useBrand } from "../brand";
import { BrandMark } from "../components/BrandMark";
import { navigate } from "../router";

export function Login() {
  const brand = useBrand();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", { username, password });
      navigate("/admin", true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("Credenziali non valide.");
      else if (err instanceof ApiError && err.status === 429) setError("Troppi tentativi. Riprova tra qualche minuto.");
      else setError("Impossibile contattare il server.");
    } finally {
      setBusy(false);
    }
  }

  async function recover(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await recoverPassword(username, code, newPassword);
      setNotice("Password aggiornata. Ora puoi accedere con la nuova password.");
      setRecovering(false);
      setCode("");
      setNewPassword("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("Codice di recupero non valido o già usato.");
      else if (err instanceof ApiError && err.status === 400) setError("Password troppo corta: almeno 12 caratteri.");
      else setError("Impossibile completare il recupero.");
    } finally {
      setBusy(false);
    }
  }

  if (recovering) {
    return (
      <div className="auth-page">
        <form className="card auth-card" onSubmit={recover}>
          <BrandMark name={brand} size={42} />
          <p className="auth-title">Recupero con codice</p>
          <p className="muted small" style={{ margin: 0 }}>
            Inserisci uno dei codici di recupero ricevuti quando hai impostato la password, poi scegli la nuova
            password.
          </p>
          <label className="field">
            <span>Utente</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span>Codice di recupero</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ABCDE-FGHIJ"
              autoComplete="one-time-code"
              required
            />
          </label>
          <label className="field">
            <span>Nuova password (min. 12 caratteri)</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </label>
          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Verifica…" : "Imposta nuova password"}
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => setRecovering(false)}>
            Torna al login
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <BrandMark name={brand} size={42} />
        <p className="auth-title">Area conduttore</p>

        <label className="field">
          <span>Utente</span>
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
            placeholder="il tuo nome utente"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="la tua password"
          />
        </label>

        {error && <p className="error-text">{error}</p>}
        {notice && <p className="ok-text">{notice}</p>}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Accesso…" : "Accedi"}
        </button>
        <button
          className="btn-link"
          type="button"
          onClick={() => {
            setError(null);
            setNotice(null);
            setRecovering(true);
          }}
        >
          Password dimenticata?
        </button>
      </form>
    </div>
  );
}
