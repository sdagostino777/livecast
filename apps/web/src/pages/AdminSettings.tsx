import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  Checks,
  Me,
  PublicUser,
  removeBrandLogo,
  Settings,
  StreamView,
  uploadBrandLogo,
} from "../api";
import { useBrand } from "../brand";
import { BrandMark } from "../components/BrandMark";
import { formatDate, navigate } from "../router";

/**
 * The tab icon follows the install's logo. Called after every logo change so the
 * browser does not keep showing the old symbol until the next reload.
 */
export function applyTabIcon(logoUrl: string | null): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (logoUrl) link.href = logoUrl;
  else link.href = DEFAULT_TAB_ICON;
}

/** The play symbol the project ships with, restored when no logo is uploaded. */
const DEFAULT_TAB_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230a0a0a'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23ff3b30'/%3E%3Cpath d='M13 12.5 21 16l-8 3.5z' fill='white'/%3E%3C/svg%3E";

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Sessione scaduta: accedi di nuovo.";
    if (err.status === 403) return "Operazione riservata all'amministratore.";
    if (err.status === 413) return "Immagine troppo grande (max 6 MB).";
    if (err.status === 400 && err.message === "unsupported_image_format") return "Formato non supportato: usa JPG, PNG o WebP.";
    return `Errore (${err.status}): ${err.message}`;
  }
  return "Impossibile contattare il server.";
}

/**
 * The gear page: everything about the install itself (appearance, event
 * images), the account (password) and, for admins, the people who operate it.
 * The dashboard stays operational; this page is configuration.
 */
export function AdminSettings() {
  const brand = useBrand();
  const [me, setMe] = useState<Me["user"] | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async (role?: "admin" | "operator") => {
    try {
      const streamList = await api.get<{ streams: StreamView[] }>("/api/admin/streams");
      setStreams(streamList.streams);
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

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2500);
  };

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

  if (!me) {
    return (
      <div className="loading-page">
        <span className="spinner" aria-label="Caricamento" />
      </div>
    );
  }

  const latest = streams[0] ?? null;
  void latest;

  return (
    <div className="admin">
      <header className="admin-top">
        <BrandMark name={brand} />
        <div className="admin-user">
          <button className="btn btn-ghost btn-small" onClick={() => navigate("/admin")}>
            ← Pannello
          </button>
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}
      {toast && <div className="banner banner-ok">{toast}</div>}

      <SettingsPanel notify={notify} />

      <SecurityPanel notify={notify} />

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

      <MaintenancePanel notify={notify} />
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
                      <button
                        className="btn btn-ghost btn-small"
                        onClick={() => {
                          setResetFor(u.id);
                          setResetPw("");
                        }}
                      >
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

function SecurityPanel({ notify }: { notify: (m: string) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [regenPassword, setRegenPassword] = useState("");
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  useEffect(() => {
    api
      .get<{ remaining: number }>("/api/admin/recovery-codes")
      .then((res) => setRemaining(res.remaining))
      .catch(() => setRemaining(null));
  }, [newCodes]);

  async function regenerate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ recoveryCodes: string[] }>("/api/admin/recovery-codes", { password: regenPassword });
      setNewCodes(res.recoveryCodes);
      setRegenPassword("");
      notify("Nuovi codici generati: salvali ora.");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

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
      {newCodes && (
        <div className="banner banner-ok">
          <p className="small" style={{ margin: 0 }}>
            Nuovi codici di recupero (mostrati una sola volta): <b>{newCodes.join(" · ")}</b>
          </p>
        </div>
      )}
      <p className="muted small">
        Codici di recupero disponibili: <b>{remaining ?? "…"}</b>. Servono se dimentichi la password: si usano dalla
        pagina di login («Password dimenticata?»).
      </p>
      <form className="row wrap" onSubmit={regenerate}>
        <input
          className="input"
          type="password"
          placeholder="Password attuale per rigenerare i codici"
          autoComplete="current-password"
          value={regenPassword}
          onChange={(e) => setRegenPassword(e.target.value)}
        />
        <button className="btn btn-ghost btn-small" type="submit" disabled={busy || !regenPassword}>
          Rigenera codici
        </button>
      </form>
      <hr className="sep" />

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

function MaintenancePanel({ notify }: { notify: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);
  const [logs, setLogs] = useState<{ source: string; lines: string[] } | null>(null);
  const [openLogs, setOpenLogs] = useState(false);

  async function reset() {
    if (!window.confirm("Chiudere le trasmissioni rimaste appese e rimuovere i segmenti?")) return;
    setBusy(true);
    try {
      const res = await api.post<{ cleaned: string[] }>("/api/admin/broadcast/reset");
      setResult(res.cleaned.length ? res.cleaned : ["niente da fare"]);
      notify("Pulizia completata.");
    } catch {
      setResult(["operazione non riuscita"]);
    } finally {
      setBusy(false);
    }
  }

  async function loadLogs() {
    setOpenLogs((open) => !open);
    try {
      const res = await api.get<{ source: string; lines: string[] }>("/api/admin/logs?lines=200");
      setLogs({ source: res.source, lines: res.lines.slice(-200) });
    } catch {
      setLogs({ source: "errore", lines: ["impossibile leggere i log"] });
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Manutenzione</h2>
        <button className="btn btn-ghost btn-small" onClick={() => void loadLogs()}>
          {openLogs ? "Nascondi log" : "Mostra log"}
        </button>
      </div>

      <div className="row wrap">
        <button className="btn btn-danger" disabled={busy} onClick={() => void reset()}>
          Termina trasmissioni appese
        </button>
        <span className="muted small">
          Chiude la diretta in corso, riporta a «pronta» ogni stato rimasto appeso e cancella i segmenti.
        </span>
      </div>

      {result && (
        <div className="banner banner-ok" style={{ marginTop: 12 }}>
          <span className="small">{result.join(" · ")}</span>
        </div>
      )}

      {openLogs && (
        <>
          <p className="muted small" style={{ marginBottom: 6 }}>
            Sorgente: {logs?.source ?? "…"}
          </p>
          <pre className="log-view">{(logs?.lines ?? []).join("\n") || "nessuna riga"}</pre>
        </>
      )}
    </section>
  );
}

function SettingsPanel({ notify }: { notify: (m: string) => void }) {
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoVersion, setLogoVersion] = useState(0);
  const logoRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api
      .get<Settings>("/api/admin/settings")
      .then(setForm)
      .catch(() => setError("Impossibile leggere le impostazioni."));
    api
      .get<{ name: string; logoUrl: string | null }>("/api/brand")
      .then((brand) => setLogoUrl(brand.logoUrl))
      .catch(() => undefined);
  }, []);

  async function changeLogo(file: File) {
    setBusy(true);
    setError(null);
    try {
      const saved = await uploadBrandLogo(file);
      setLogoUrl(saved.logoUrl);
      setLogoVersion((version) => version + 1);
      applyTabIcon(saved.logoUrl);
      notify("Logo aggiornato: cambia anche l'icona della scheda.");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function dropLogo() {
    setBusy(true);
    try {
      await removeBrandLogo();
      setLogoUrl(null);
      setLogoVersion((version) => version + 1);
      applyTabIcon(null);
      notify("Logo rimosso: torna il simbolo generato.");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

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
      applyTabIcon(logoUrl);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function testCdn() {
    if (!form) return;
    setBusy(true);
    try {
      const target = form.cdnBaseUrl || form.publicBaseUrl;
      const res = await api.post<{ ok: boolean; probe: string; status?: number; headers?: Record<string, string | null> }>(
        "/api/admin/cdn-test",
        { url: target },
      );
      notify(res.ok ? "CDN raggiungibile." : "CDN non raggiungibile.");
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
            ? "CDN attiva: impianto adatto a migliaia di spettatori. Verifica che i LED siano verdi prima dell'evento."
            : "Capacità del VPS: fino a ~500 spettatori simultanei il VPS da solo basta. Oltre serve la CDN: imposta l'URL qui sotto e verifica il LED verde."}
        </span>
      </div>

      <form className="grid-2" onSubmit={save}>
        <div className="span-2 row wrap" style={{ gap: 16, alignItems: "flex-start" }}>
          <label className="field grow" style={{ minWidth: 260 }}>
            <span>Nome del servizio</span>
            <input
              className="input"
              value={form.brandName}
              maxLength={40}
              placeholder="Nome del servizio"
              onChange={(e) => setField("brandName", e.target.value)}
            />
            <em className="muted">
              Il nome che gli spettatori leggono ovunque: pagina, player, titolo del browser. Il progetto è tuo, il nome
              lo scegli tu.
            </em>
          </label>
          <div className="stack" style={{ gap: 8, minWidth: 220 }}>
            <span className="small muted">Simbolo accanto al nome</span>
            <div className="row" style={{ gap: 12, alignItems: "center" }}>
              {logoUrl ? (
                <img
                  className="upload-preview"
                  style={{ width: 52, height: 52, borderRadius: 14, objectFit: "contain" }}
                  src={`${logoUrl}?v=${logoVersion}`}
                  alt="Logo attuale"
                />
              ) : (
                <span className="brand-mark" style={{ width: 52, height: 52, borderRadius: 14 }}>
                  <svg viewBox="0 0 24 24" width={26} height={26} aria-hidden>
                    <path d="M8 5v14l11-7z" fill="currentColor" />
                  </svg>
                </span>
              )}
              <div className="stack" style={{ gap: 6 }}>
                <input
                  ref={logoRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void changeLogo(file);
                  }}
                />
                <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => logoRef.current?.click()}>
                  {logoUrl ? "Cambia logo" : "Carica logo"}
                </button>
                {logoUrl && (
                  <button type="button" className="btn btn-ghost btn-small danger" disabled={busy} onClick={() => void dropLogo()}>
                    Rimuovi
                  </button>
                )}
              </div>
            </div>
            <em className="muted">
              PNG quadrato consigliato (512×512). Il logo diventa anche l'icona della scheda del browser e compare
              nell'anteprima dei link condivisi.
            </em>
          </div>
        </div>

        <label className="field">
          <span className="row">{led(checks?.origin.ok ?? null)} URL pubblico</span>
          <input className="input" value={form.publicBaseUrl} onChange={(e) => setField("publicBaseUrl", e.target.value)} />
          <em className="muted">Il dominio della diretta, con https://. Il LED verifica che risponda dal server.</em>
        </label>
        <label className="field">
          <span className="row">{led(checks?.cdnEnabled ? (checks.cdn?.ok ?? false) : null)} CDN (opzionale)</span>
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
          <span className="row">{led(checks?.ingestTcp ?? null)} Host ingest</span>
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
    </section>
  );
}
