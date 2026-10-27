import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, CdnTestResult, Me, Overview, Settings, StreamView } from "../api";
import { copyToClipboard, formatDate, formatTime, navigate } from "../router";

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return "Sessione scaduta: accedi di nuovo.";
      case 403:
        return "Operazione non consentita.";
      case 404:
        return "Elemento non trovato.";
      case 409:
        return "Operazione non possibile: c'è già una diretta attiva.";
      case 429:
        return "Troppi tentativi. Attendi un minuto.";
      default:
        return `Errore (${err.status}): ${err.message}`;
    }
  }
  return "Impossibile contattare il server.";
}

function statusLabel(ov: Overview | null): string {
  if (!ov) return "…";
  if (!ov.stream) return "Offline";
  if (ov.stream.status === "starting") return ov.ingest.ready ? "Preparazione video…" : "In attesa di OBS";
  if (ov.stream.status === "live") return "In onda";
  return "Terminata";
}

export function Admin() {
  const [me, setMe] = useState<Me["user"] | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([api.get<Overview>("/api/admin/overview"), api.get<{ streams: StreamView[] }>("/api/admin/streams")]);
      setOv(o);
      setStreams(s.streams);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate("/login", true);
        return;
      }
      setError(friendlyError(err));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await api.get<Me>("/api/auth/me");
        if (!alive) return;
        setMe(me.user);
        await refresh();
      } catch {
        if (alive) navigate("/login", true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!me) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [me, refresh]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function createAndStart(title: string, record: boolean) {
    await act(async () => {
      const created = await api.post<{ stream: StreamView }>("/api/admin/streams", { title, record });
      await api.post(`/api/admin/streams/${created.stream.id}/start`);
    });
  }

  async function stopStream(id: string) {
    await act(async () => {
      await api.post(`/api/admin/streams/${id}/stop`);
      notify("Diretta terminata.");
    });
  }

  async function deleteStream(id: string) {
    if (!window.confirm("Eliminare questa diretta dalle registrazioni del pannello?")) return;
    await act(async () => {
      await api.del(`/api/admin/streams/${id}`);
      notify("Diretta eliminata.");
    });
  }

  async function logout() {
    try {
      await api.post("/api/auth/logout");
    } finally {
      navigate("/login", true);
    }
  }

  if (!me) {
    return (
      <div className="loading-page">
        <span className="spinner" aria-label="Caricamento" />
      </div>
    );
  }

  const active = ov?.stream ?? null;

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="brand">
          <span className="dot" aria-hidden />
          NDX <b>Live</b>
          <span className="muted small">pannello</span>
        </div>
        <div className="admin-user">
          <span className="muted small">{me.username}</span>
          <button className="btn btn-ghost btn-small" onClick={logout}>
            Esci
          </button>
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}
      {toast && <div className="banner banner-ok">{toast}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Diretta</h2>
          <span className={`pill ${ov?.stream?.status ?? "off"}`}>{statusLabel(ov)}</span>
        </div>

        {active ? (
          <div className="stack">
            <div className="row-between">
              <div>
                <p className="stream-title">{active.title}</p>
                <p className="muted small mono">{active.slug}</p>
              </div>
              <div className="row">
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => void copyToClipboard(active.pageUrl).then(() => notify("Link copiato."))}
                >
                  Copia link
                </button>
                <button className="btn btn-danger btn-small" disabled={busy} onClick={() => void stopStream(active.id)}>
                  Termina
                </button>
              </div>
            </div>

            <p className="muted small">
              In onda dalle {formatTime(active.startedAt)} ·{" "}
              {active.record ? "registrazione attiva" : "nessuna registrazione"}
            </p>

            <ObsPanel ov={ov} />
          </div>
        ) : (
          <div className="stack">
            <p className="muted small">Nessuna diretta attiva. Crea la prossima qui sotto.</p>
            <NewStreamForm disabled={busy} onCreate={createAndStart} />
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Dirette</h2>
          <span className="muted small">{streams.length}</span>
        </div>
        {streams.length === 0 ? (
          <p className="muted small">Nessuna diretta creata.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Titolo</th>
                <th>Stato</th>
                <th>Creata</th>
                <th aria-label="azioni" />
              </tr>
            </thead>
            <tbody>
              {streams.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="stream-title small">{s.title}</span>
                    <br />
                    <span className="muted small mono">{s.slug}</span>
                  </td>
                  <td>
                    <span className={`pill ${s.status}`}>{s.status === "live" ? "In onda" : s.status === "starting" ? "Avvio" : s.status === "ended" ? "Terminata" : "Bozza"}</span>
                  </td>
                  <td className="muted small">{formatDate(s.createdAt)}</td>
                  <td className="cell-actions">
                    {!active && (s.status === "draft" || s.status === "ended") && (
                      <button
                        className="btn btn-primary btn-small"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api.post(`/api/admin/streams/${s.id}/start`);
                          })
                        }
                      >
                        Vai in onda
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-small"
                      onClick={() => void copyToClipboard(`${location.origin}/live/${s.slug}`).then(() => notify("Link copiato."))}
                    >
                      Link
                    </button>
                    {s.status !== "live" && s.status !== "starting" && (
                      <button className="btn btn-ghost btn-small danger" disabled={busy} onClick={() => void deleteStream(s.id)}>
                        Elimina
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <SettingsPanel />
      <SecurityPanel me={me} onMeChanged={setMe} notify={notify} />
    </div>
  );
}

function NewStreamForm({ disabled, onCreate }: { disabled: boolean; onCreate: (title: string, record: boolean) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [record, setRecord] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    await onCreate(title.trim(), record);
    setTitle("");
  }

  return (
    <form className="row wrap" onSubmit={submit}>
      <input
        className="input grow"
        placeholder="Titolo della diretta (es. Assemblea annuale)"
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label className="check">
        <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
        Registra
      </label>
      <button className="btn btn-primary" type="submit" disabled={disabled || !title.trim()}>
        Crea e vai in onda
      </button>
    </form>
  );
}

function ObsPanel({ ov }: { ov: Overview | null }) {
  const [revealed, setRevealed] = useState<{ server: string; streamKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ov) return null;

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      setRevealed(await api.get<{ server: string; streamKey: string }>("/api/admin/ingest"));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="obs">
      <div className="obs-head">
        <span className={`dot ${ov.ingest.ready ? "on" : "off"}`} aria-hidden />
        <span className="small">{ov.ingest.ready ? "OBS collegato" : "OBS non collegato"}</span>
        {!ov.ingest.reachable && <span className="muted small">(server media non raggiungibile)</span>}
      </div>

      <p className="muted small">
        In OBS: <b>Server</b> = l'URL completo con credenziali (pulsante sotto), <b>Stream Key</b> vuota.
      </p>
      <p className="muted small mono ellipsis">Base: {ov.ingest.server}</p>
      <div className="code-row">
        <code className="code">{ov.ingest.server}</code>
        <button className="btn btn-ghost btn-small" onClick={() => void copyToClipboard(ov.ingest.server).then(() => undefined)}>
          Copia
        </button>
      </div>

      {revealed ? (
        <>
          <p className="muted small">URL completo con credenziali (incollalo in OBS):</p>
          <div className="code-row">
            <code className="code">{revealed.server}</code>
            <button className="btn btn-ghost btn-small" onClick={() => void copyToClipboard(revealed.server).then(() => undefined)}>
              Copia
            </button>
          </div>
          <button className="btn btn-ghost btn-small" onClick={() => setRevealed(null)}>
            Nascondi
          </button>
        </>
      ) : (
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={reveal}>
          Mostra credenziali
        </button>
      )}

      {error && <p className="error-text small">{error}</p>}
      {ov.pipeline.lastError && <p className="muted small mono ellipsis">{ov.pipeline.lastError}</p>}
    </div>
  );
}

function SettingsPanel() {
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cdnResult, setCdnResult] = useState<CdnTestResult | null>(null);

  useEffect(() => {
    api
      .get<Settings>("/api/admin/settings")
      .then(setForm)
      .catch(() => setError("Impossibile leggere le impostazioni."));
  }, []);

  if (!form) return null;

  function field<K extends keyof Settings>(key: K) {
    return (value: string) => setForm({ ...form!, [key]: value } as Settings);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api.put<Settings>("/api/admin/settings", {
        publicBaseUrl: form.publicBaseUrl,
        cdnBaseUrl: form.cdnBaseUrl,
        ingestHost: form.ingestHost,
        ingestPort: Number(form.ingestPort) || 1935,
      });
      setForm(saved);
      setMessage("Impostazioni salvate.");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function testCdn() {
    if (!form) return;
    setCdnResult(null);
    setBusy(true);
    try {
      const target = form.cdnBaseUrl || form.publicBaseUrl;
      setCdnResult(await api.post<CdnTestResult>("/api/admin/cdn-test", { url: target }));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Configurazione</h2>
        <button className="btn btn-ghost btn-small" onClick={() => void testCdn()} disabled={busy}>
          Verifica CDN
        </button>
      </div>

      <form className="grid-2" onSubmit={save}>
        <label className="field">
          <span>URL pubblico</span>
          <input className="input" value={form.publicBaseUrl} onChange={(e) => field("publicBaseUrl")(e.target.value)} />
          <em className="muted small">Il dominio della diretta, con https://.</em>
        </label>
        <label className="field">
          <span>CDN (opzionale)</span>
          <input
            className="input"
            value={form.cdnBaseUrl}
            placeholder="https://cdn.esempio.com"
            onChange={(e) => field("cdnBaseUrl")(e.target.value)}
          />
          <em className="muted small">Vuoto = video servito dal VPS. Se impostata, spettatori caricano i segmenti da qui.</em>
        </label>
        <label className="field">
          <span>Host ingest OBS</span>
          <input className="input" value={form.ingestHost} onChange={(e) => field("ingestHost")(e.target.value)} />
          <em className="muted small">Può differire dal dominio pubblico (es. IP del VPS).</em>
        </label>
        <label className="field">
          <span>Porta ingest</span>
          <input
            className="input"
            type="number"
            min={1}
            max={65535}
            value={form.ingestPort}
            onChange={(e) => setForm({ ...form, ingestPort: Number(e.target.value) })}
          />
          <em className="muted small">Default 1935 (RTMP).</em>
        </label>

        <div className="row-between span-2">
          <span className="muted small">
            In onda via: <code className="code-inline">{form.hlsBaseUrl}</code>
          </span>
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Salva
          </button>
        </div>
      </form>

      {message && <p className="ok-text small">{message}</p>}
      {error && <p className="error-text small">{error}</p>}

      {cdnResult && (
        <div className={`banner banner-${cdnResult.ok ? "ok" : "error"}`}>
          <span className="small">
            {cdnResult.ok ? "CDN raggiungibile" : "CDN non raggiungibile"} · {cdnResult.probe}
            {cdnResult.status !== undefined && ` · HTTP ${cdnResult.status}`}
            {cdnResult.headers?.["x-cache"] && ` · cache: ${cdnResult.headers["x-cache"]}`}
          </span>
        </div>
      )}
    </section>
  );
}

function SecurityPanel({ me, onMeChanged, notify }: { me: Me["user"]; onMeChanged: (u: Me["user"]) => void; notify: (m: string) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/admin/password", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      notify("Password aggiornata.");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function setupTotp() {
    setBusy(true);
    setError(null);
    try {
      setTotpSetup(await api.post<{ secret: string; otpauthUrl: string }>("/api/admin/totp/setup"));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function enableTotp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/admin/totp/enable", { code: totpCode });
      onMeChanged({ ...me, totpEnabled: true });
      setTotpSetup(null);
      setTotpCode("");
      notify("2FA attivo.");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function disableTotp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/admin/totp/disable", { password: disablePassword });
      onMeChanged({ ...me, totpEnabled: false });
      setDisablePassword("");
      notify("2FA disattivato.");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Sicurezza</h2>
      </div>
      {error && <p className="error-text small">{error}</p>}

      <form className="stack" onSubmit={changePassword}>
        <p className="small muted">Cambia password (le altre sessioni vengono chiuse):</p>
        <div className="row wrap">
          <input
            className="input"
            type="password"
            placeholder="Password attuale"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          <input
            className="input"
            type="password"
            placeholder="Nuova password (min. 12 caratteri)"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={12}
            required
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
            Aggiorna
          </button>
        </div>
      </form>

      <hr className="sep" />

      {me.totpEnabled ? (
        <form className="stack" onSubmit={disableTotp}>
          <p className="small muted">2FA attivo. Per disattivarlo conferma la password:</p>
          <div className="row wrap">
            <input
              className="input"
              type="password"
              placeholder="Password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              required
            />
            <button className="btn btn-ghost btn-small" type="submit" disabled={busy}>
              Disattiva 2FA
            </button>
          </div>
        </form>
      ) : totpSetup ? (
        <form className="stack" onSubmit={enableTotp}>
          <p className="small muted">Aggiungi questo segreto alla tua app di autenticazione, poi inserisci il codice:</p>
          <code className="code">{totpSetup.secret}</code>
          <code className="code small muted">{totpSetup.otpauthUrl}</code>
          <div className="row wrap">
            <input
              className="input"
              inputMode="numeric"
              maxLength={6}
              placeholder="Codice a 6 cifre"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
              required
            />
            <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
              Abilita 2FA
            </button>
          </div>
        </form>
      ) : (
        <div className="stack">
          <p className="small muted">2FA non attivo: protegge l'account del conduttore da un accesso rubato.</p>
          <div>
            <button className="btn btn-ghost btn-small" onClick={() => void setupTotp()} disabled={busy}>
              Configura 2FA
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
