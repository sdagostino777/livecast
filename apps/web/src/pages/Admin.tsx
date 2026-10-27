import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, CdnTestResult, Checks, Me, Overview, PublicUser, Settings, StreamView } from "../api";
import { useBrand } from "../brand";
import { BrandMark } from "../components/BrandMark";
import { copyToClipboard, formatDate, formatTime, navigate } from "../router";

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return "Sessione scaduta: accedi di nuovo.";
      case 403:
        return "Operazione riservata all'amministratore.";
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

function kindLabel(kind: "video" | "audio"): string {
  return kind === "audio" ? "Solo audio" : "Video";
}

function statusLabel(ov: Overview | null): string {
  if (!ov) return "…";
  if (!ov.stream) return "Offline";
  if (ov.stream.status === "starting") return ov.ingest.ready ? "Preparazione…" : "In attesa di OBS";
  if (ov.stream.status === "live") return "In onda";
  return "Terminata";
}

export function Admin() {
  const brand = useBrand();
  const [me, setMe] = useState<Me["user"] | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const refresh = useCallback(async (role?: "admin" | "operator") => {
    try {
      const [overview, streamList] = await Promise.all([
        api.get<Overview>("/api/admin/overview"),
        api.get<{ streams: StreamView[] }>("/api/admin/streams"),
      ]);
      setOv(overview);
      setStreams(streamList.streams);
      setError(null);
      if (role === "admin") {
        const userList = await api.get<{ users: PublicUser[] }>("/api/admin/users");
        setUsers(userList.users);
      }
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
        const who = await api.get<Me>("/api/auth/me");
        if (!alive) return;
        setMe(who.user);
        await refresh(who.user.role);
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
    const timer = window.setInterval(() => void refresh(me.role), 5000);
    return () => window.clearInterval(timer);
  }, [me, refresh]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh(me?.role);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function createAndStart(title: string, kind: "video" | "audio", record: boolean) {
    await act(async () => {
      const created = await api.post<{ stream: StreamView }>("/api/admin/streams", { title, kind, record });
      await api.post(`/api/admin/streams/${created.stream.id}/start`);
    });
  }

  async function startStream(id: string) {
    await act(async () => {
      await api.post(`/api/admin/streams/${id}/start`);
    });
  }

  async function stopStream(id: string) {
    await act(async () => {
      await api.post(`/api/admin/streams/${id}/stop`);
      notify("Diretta terminata.");
    });
  }

  async function deleteStream(id: string) {
    if (!window.confirm("Eliminare questa diretta dai registri del pannello?")) return;
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
        <BrandMark name={brand} />
        <div className="admin-user">
          <span className="small">
            {me.username}
            {me.role === "admin" && <span className="pill" style={{ marginLeft: 8 }}>admin</span>}
          </span>
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
                <p className="muted small mono">
                  {active.slug} · {kindLabel(active.kind)}
                </p>
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
              In onda dalle {formatTime(active.startedAt)} · {active.record ? "registrazione attiva" : "nessuna registrazione"}
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
                <th>Tipo</th>
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
                  <td className="small">{kindLabel(s.kind)}</td>
                  <td>
                    <span className={`pill ${s.status}`}>
                      {s.status === "live" ? "In onda" : s.status === "starting" ? "Avvio" : s.status === "ended" ? "Terminata" : "Bozza"}
                    </span>
                  </td>
                  <td className="muted small">{formatDate(s.createdAt)}</td>
                  <td className="cell-actions">
                    {!active && (s.status === "draft" || s.status === "ended") && (
                      <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void startStream(s.id)}>
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

      {me.role === "admin" && (
        <UsersPanel
          users={users}
          busy={busy}
          onCreate={(username, password) =>
            act(async () => {
              await api.post("/api/admin/users", { username, password });
              notify("Utente creato.");
            })
          }
          onResetPassword={(id, password) =>
            act(async () => {
              await api.post(`/api/admin/users/${id}/password`, { password });
              notify("Password aggiornata per l'utente.");
            })
          }
          onDelete={(id) => {
            if (!window.confirm("Eliminare questo utente?")) return;
            void act(async () => {
              await api.del(`/api/admin/users/${id}`);
              notify("Utente eliminato.");
            });
          }}
        />
      )}

      <SettingsPanel notify={notify} />
      <SecurityPanel notify={notify} />
    </div>
  );
}

function NewStreamForm({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (title: string, kind: "video" | "audio", record: boolean) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"video" | "audio">("video");
  const [record, setRecord] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    await onCreate(title.trim(), kind, record);
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
      <div className="choice" role="radiogroup" aria-label="Tipo di trasmissione">
        <label>
          <input type="radio" name="kind" checked={kind === "video"} onChange={() => setKind("video")} />
          Video
        </label>
        <label>
          <input type="radio" name="kind" checked={kind === "audio"} onChange={() => setKind("audio")} />
          Solo audio
        </label>
      </div>
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
  const [revealed, setRevealed] = useState<{ server: string; backupServer?: string; streamKey: string } | null>(null);
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

  const using = ov.ingest.currentInput === "backup" ? "backup" : "principale";

  return (
    <div className="obs">
      <div className="obs-head">
        <span className={`dot ${ov.ingest.ready ? "on" : "off"}`} aria-hidden />
        <span className="small">Encoder principale: {ov.ingest.ready ? "collegato" : "non collegato"}</span>
      </div>
      <div className="obs-head">
        <span className={`dot ${ov.ingest.backupReady ? "on" : "off"}`} aria-hidden />
        <span className="small">Encoder backup: {ov.ingest.backupReady ? "collegato" : "non collegato"}</span>
      </div>
      {!ov.ingest.reachable && <span className="muted small">(server media non raggiungibile)</span>}
      <p className="muted small">
        In uso: <b>{ov.ingest.currentInput ? using : "—"}</b>. Se l'encoder principale si interrompe, la regia
        ripassa da sola sul backup in pochi secondi.
      </p>

      <p className="small">
        In OBS: <b>Server</b> = l'URL completo con credenziali (pulsante sotto), <b>Stream Key</b> vuota.
      </p>
      <p className="muted small mono ellipsis">Principale: {ov.ingest.server}</p>
      <p className="muted small mono ellipsis">Backup: {ov.ingest.backupServer}</p>

      {revealed ? (
        <>
          <p className="muted small">URL completo con credenziali — principale (per OBS):</p>
          <div className="code-row">
            <code className="code">{revealed.server}</code>
            <button className="btn btn-ghost btn-small" onClick={() => void copyToClipboard(revealed.server)}>
              Copia
            </button>
          </div>
          {revealed.backupServer && (
            <>
              <p className="muted small">Backup (per il secondo encoder, se lo usi):</p>
              <div className="code-row">
                <code className="code">{revealed.backupServer}</code>
                <button className="btn btn-ghost btn-small" onClick={() => void copyToClipboard(revealed.backupServer!)}>
                  Copia
                </button>
              </div>
            </>
          )}
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

function UsersPanel({
  users,
  busy,
  onCreate,
  onResetPassword,
  onDelete,
}: {
  users: PublicUser[];
  busy: boolean;
  onCreate: (username: string, password: string) => Promise<void>;
  onResetPassword: (id: string, password: string) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || password.length < 12) return;
    await onCreate(username.trim(), password);
    setUsername("");
    setPassword("");
  }

  async function reset(event: FormEvent, id: string) {
    event.preventDefault();
    if (resetPw.length < 12) return;
    await onResetPassword(id, resetPw);
    setResetFor(null);
    setResetPw("");
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Utenti</h2>
        <span className="muted small">{users.length}</span>
      </div>

      <form className="user-form" onSubmit={create}>
        <label className="field">
          <span>Nuovo utente</span>
          <input
            className="input"
            placeholder="nome utente"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>Password (min. 12)</span>
          <input
            className="input"
            type="password"
            placeholder="password iniziale"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy || !username.trim() || password.length < 12}>
          Crea utente
        </button>
      </form>

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Utente</th>
            <th>Ruolo</th>
            <th>Creato</th>
            <th aria-label="azioni" />
          </tr>
        </thead>
        <tbody>
          {users.map((u) =>
            resetFor === u.id ? (
              <tr key={u.id}>
                <td colSpan={4}>
                  <form className="row wrap" onSubmit={(e) => void reset(e, u.id)}>
                    <span className="small">
                      Nuova password per <b>{u.username}</b>:
                    </span>
                    <input
                      className="input grow"
                      type="password"
                      autoComplete="new-password"
                      value={resetPw}
                      onChange={(e) => setResetPw(e.target.value)}
                      minLength={12}
                      required
                    />
                    <button className="btn btn-primary btn-small" type="submit" disabled={busy || resetPw.length < 12}>
                      Salva
                    </button>
                    <button className="btn btn-ghost btn-small" type="button" onClick={() => setResetFor(null)}>
                      Annulla
                    </button>
                  </form>
                </td>
              </tr>
            ) : (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>
                  <span className="pill">{u.role === "admin" ? "admin" : "conduttore"}</span>
                </td>
                <td className="muted small">{formatDate(u.createdAt)}</td>
                <td className="cell-actions">
                  {u.role === "admin" ? (
                    <span className="muted small">account protetto</span>
                  ) : (
                    <>
                      <button className="btn btn-ghost btn-small" onClick={() => { setResetFor(u.id); setResetPw(""); }}>
                        Password
                      </button>
                      <button className="btn btn-ghost btn-small danger" onClick={() => onDelete(u.id)}>
                        Elimina
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      <p className="muted small" style={{ marginTop: 12 }}>
        L'account admin non è modificabile da qui: cambia la sua password in Sicurezza. Gli altri utenti possono
        condurre dirette ma non gestire utenti o configurazione.
      </p>
    </section>
  );
}

function SettingsPanel({ notify }: { notify: (m: string) => void }) {
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cdnResult, setCdnResult] = useState<CdnTestResult | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);

  useEffect(() => {
    api
      .get<Settings>("/api/admin/settings")
      .then(setForm)
      .catch(() => setError("Impossibile leggere le impostazioni."));
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .get<Checks>("/api/admin/checks")
        .then((c) => alive && setChecks(c))
        .catch(() => alive && setChecks(null));
    };
    tick();
    const timer = window.setInterval(tick, 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  function led(ok: boolean | null) {
    return <span className={`dot ${ok === null ? "off" : ok ? "on" : ""}`} aria-hidden />;
  }

  if (!form) return null;

  function setField<K extends keyof Settings>(key: K, value: string | number) {
    setForm({ ...form!, [key]: value } as Settings);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api.put<Settings>("/api/admin/settings", {
        brandName: form.brandName,
        publicBaseUrl: form.publicBaseUrl,
        cdnBaseUrl: form.cdnBaseUrl,
        ingestHost: form.ingestHost,
        ingestPort: Number(form.ingestPort) || 1935,
      });
      setForm(saved);
      setMessage("Impostazioni salvate.");
      notify("Impostazioni salvate.");
      document.title = saved.brandName;
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

      <div className={`banner ${checks?.cdnEnabled ? "banner-ok" : "banner-error"}`} style={{ marginBottom: 18 }}>
        <span className="small">
          {checks?.cdnEnabled
            ? "CDN attiva: impianto adatto a migliaia di spettatori. Controlla che i tre LED siano verdi prima dell'evento."
            : "Capacità del VPS: fino a ~500 spettatori simultanei il VPS da solo basta. Oltre serve la CDN: imposta l'URL qui sotto e verifica il LED verde."}
        </span>
      </div>

      <form className="grid-2" onSubmit={save}>
        <label className="field">
          <span>Nome dell'installazione</span>
          <input className="input" value={form.brandName} onChange={(e) => setField("brandName", e.target.value)} maxLength={40} />
          <em className="muted">Compare nel pannello, nel player e nel titolo della pagina.</em>
        </label>
        <label className="field">
          <span className="row">{led(checks?.origin.ok ?? null)} URL pubblico</span>
          <input className="input" value={form.publicBaseUrl} onChange={(e) => setField("publicBaseUrl", e.target.value)} />
          <em className="muted">Il dominio della diretta, con https://. Il LED verifica che risponda dal server.</em>
        </label>
        <label className="field">
          <span className="row">
            {led(checks?.cdnEnabled ? checks.cdn?.ok ?? false : null)} CDN (opzionale)
          </span>
          <input
            className="input"
            value={form.cdnBaseUrl}
            placeholder="https://cdn.esempio.com"
            onChange={(e) => setField("cdnBaseUrl", e.target.value)}
          />
          <em className="muted">
            Vuoto = spettatori serviti dal VPS. Con una CDN, i segmenti arrivano dall'edge e il VPS regge carichi molto
            più grandi.
          </em>
        </label>
        <label className="field">
          <span className="row">{led(checks?.ingestTcp ?? null)} Host ingest OBS</span>
          <input className="input" value={form.ingestHost} onChange={(e) => setField("ingestHost", e.target.value)} />
          <em className="muted">Può differire dal dominio pubblico (es. IP del VPS). Il LED verifica la porta RTMP.</em>
        </label>
        <label className="field">
          <span>Porta ingest</span>
          <input
            className="input"
            type="number"
            min={1}
            max={65535}
            value={form.ingestPort}
            onChange={(e) => setField("ingestPort", Number(e.target.value))}
          />
          <em className="muted">Default 1935 (RTMP).</em>
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

function SecurityPanel({ notify }: { notify: (m: string) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <section className="card">
      <div className="card-head">
        <h2>Sicurezza</h2>
      </div>
      {error && <p className="error-text small">{error}</p>}

      <form className="stack" onSubmit={changePassword}>
        <p className="small muted">Cambia la tua password (le altre sessioni vengono chiuse):</p>
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
    </section>
  );
}
