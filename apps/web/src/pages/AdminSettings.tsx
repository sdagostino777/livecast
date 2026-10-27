import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, iconSrc, Me, posterSrc, PublicUser, StreamView, uploadStreamImage } from "../api";
import { useBrand } from "../brand";
import { BrandMark } from "../components/BrandMark";
import { formatDate, navigate } from "../router";
import { Theme, useTheme } from "../theme";

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

      <ThemeSection />

      <EventImagesSection
        latest={latest}
        busy={busy}
        onPalette={(palette) => {
          if (!latest) return;
          void act(async () => {
            await api.patch(`/api/admin/streams/${latest.id}`, { posterPalette: palette });
            notify("Palette aggiornata.");
          });
        }}
        onUpload={(kind, file) => {
        if (!latest) return;
          void act(async () => {
            await uploadStreamImage(latest.id, kind, file);
            notify(kind === "poster" ? "Poster aggiornato." : "Icona aggiornata.");
          });
        }}
        onRemove={(kind) => {
        if (!latest) return;
        void act(async () => {
          await api.del(`/api/admin/streams/${latest.id}/${kind}`);
          notify(kind === "poster" ? "Poster rimosso." : "Icona rimossa.");
        });
      }} />

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
    </div>
  );
}

function ThemeSection() {
  const [theme, setTheme] = useTheme();
  const options: Array<{ value: Theme; label: string; icon: string }> = [
    { value: "light", label: "Chiaro", icon: "☀" },
    { value: "dark", label: "Scuro", icon: "☾" },
    { value: "system", label: "Sistema", icon: "▣" },
  ];
  return (
    <section className="card">
      <div className="card-head">
        <h2>Aspetto</h2>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Il tema si applica a questa installazione nel tuo browser. Il player resta scuro: un video su fondo chiaro è
        più faticoso da guardare.
      </p>
      <div className="segmented" role="radiogroup" aria-label="Tema">
        {options.map((option) => (
          <label key={option.value} className={theme === option.value ? "active" : ""}>
            <input
              type="radio"
              name="theme"
              checked={theme === option.value}
              onChange={() => setTheme(option.value)}
            />
            <span aria-hidden>{option.icon}</span>
            {option.label}
          </label>
        ))}
      </div>
    </section>
  );
}

const PALETTES: Array<{ value: string; label: string; css: string }> = [
  { value: "blue", label: "Blu", css: "linear-gradient(135deg,#0f3559,#2a6cb6)" },
  { value: "teal", label: "Petrolio", css: "linear-gradient(135deg,#0b3b4a,#1d7a8c)" },
  { value: "indigo", label: "Indaco", css: "linear-gradient(135deg,#1e1a4d,#4f46a5)" },
  { value: "slate", label: "Ardesia", css: "linear-gradient(135deg,#12212e,#3f6076)" },
  { value: "plum", label: "Prugna", css: "linear-gradient(135deg,#3a1f3d,#8d4a63)" },
];

function EventImagesSection({
  latest,
  busy,
  onUpload,
  onRemove,
  onPalette,
}: {
  latest: StreamView | null;
  busy: boolean;
  onUpload: (kind: "poster" | "icon", file: File) => void;
  onRemove: (kind: "poster" | "icon") => void;
  onPalette: (palette: string | null) => void;
}) {
  const posterRef = useRef<HTMLInputElement | null>(null);
  const iconRef = useRef<HTMLInputElement | null>(null);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Evento</h2>
        {latest && <span className="muted small">{latest.title}</span>}
      </div>

      {!latest ? (
        <p className="muted small">Crea prima una diretta dal pannello: poster e icona appartengono alla diretta.</p>
      ) : (
        <div className="grid-2">
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>
              <b>Poster</b> (16:9): compare al posto del video prima che lo spettatore premi play.
            </p>
            <img className="upload-preview poster-preview" src={posterSrc(latest)} alt="Poster della diretta" />
            {!latest.posterUrl && (
              <>
                <p className="muted small" style={{ margin: 0 }}>
                  Template automatico con il titolo dell'evento. Scegli la palette:
                </p>
                <div className="row wrap">
                  {PALETTES.map((palette) => (
                    <button
                      key={palette.value}
                      type="button"
                      title={palette.label}
                      aria-label={palette.label}
                      disabled={busy}
                      onClick={() => onPalette(palette.value)}
                      className={`swatch${latest.posterPalette === palette.value ? " active" : ""}`}
                      style={{ background: palette.css }}
                    />
                  ))}
                  <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => onPalette(null)}>
                    Automatico
                  </button>
                </div>
                {latest.posterPalette === null && (
                  <p className="muted small" style={{ margin: 0 }}>
                    “Automatico”: la palette viene scelta dal link della diretta.
                  </p>
                )}
              </>
            )}
            <div className="row wrap">
              <input
                ref={posterRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload("poster", file);
                  event.target.value = "";
                }}
              />
              <button className="btn btn-primary btn-small" disabled={busy} onClick={() => posterRef.current?.click()}>
                Carica poster
              </button>
              {latest.posterUrl && (
                <button className="btn btn-ghost btn-small danger" disabled={busy} onClick={() => onRemove("poster")}>
                  Rimuovi
                </button>
              )}
            </div>
          </div>

          <div className="stack">
            <p className="small" style={{ margin: 0 }}>
              <b>Icona</b> (quadrata): compare negli elenchi delle dirette e accanto al titolo.
            </p>
            <img className="upload-preview icon-preview" src={iconSrc(latest)} alt="Icona della diretta" />
            {!latest.iconUrl && <p className="muted small">Icona generata dalle iniziali del titolo.</p>}
            <div className="row wrap">
              <input
                ref={iconRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload("icon", file);
                  event.target.value = "";
                }}
              />
              <button className="btn btn-primary btn-small" disabled={busy} onClick={() => iconRef.current?.click()}>
                Carica icona
              </button>
              {latest.iconUrl && (
                <button className="btn btn-ghost btn-small danger" disabled={busy} onClick={() => onRemove("icon")}>
                  Rimuovi
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
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
