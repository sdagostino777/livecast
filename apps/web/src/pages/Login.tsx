import { FormEvent, useState } from "react";
import { api, ApiError } from "../api";
import { navigate } from "../router";

export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/login", code ? { username, password, code } : { username, password });
      navigate("/admin", true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("Credenziali non valide.");
      else if (err instanceof ApiError && err.status === 429) setError("Troppi tentativi. Riprova tra qualche minuto.");
      else setError("Impossibile contattare il server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="dot" aria-hidden />
          NDX <b>Live</b>
        </div>
        <p className="muted small">Area conduttore</p>

        <label className="field">
          <span>Utente</span>
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
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
          />
        </label>
        <label className="field">
          <span>
            Codice 2FA <em className="muted">(solo se attivo)</em>
          </span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
        </label>

        {error && <p className="error-text">{error}</p>}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Accesso…" : "Accedi"}
        </button>
      </form>
    </div>
  );
}
