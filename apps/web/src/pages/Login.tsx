import { FormEvent, useState } from "react";
import { api, ApiError } from "../api";
import { useBrand } from "../brand";
import { BrandMark } from "../components/BrandMark";
import { navigate } from "../router";

export function Login() {
  const brand = useBrand();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Accesso…" : "Accedi"}
        </button>
      </form>
    </div>
  );
}
