import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, Checks, Me, Overview, Settings, StreamView, uploadStreamImage } from "../api";
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
      case 413:
        return "Immagine troppo grande (max 6 MB).";
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

function initials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

export function Admin() {
  const brand = useBrand();
  const [me, setMe] = useState<Me["user"] | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [posterTarget, setPosterTarget] = useState<string | null>(null);
  const posterInput = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [overview, streamList] = await Promise.all([
        api.get<Overview>("/api/admin/overview"),
        api.get<{ streams: StreamView[] }>("/api/admin/streams"),
      ]);
      setOv(overview);
      setStreams(streamList.streams);
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
        const who = await api.get<Me>("/api/auth/me");
        if (!alive) return;
        setMe(who.user);
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

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

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

  async function patchTitle(streamId: string, title: string) {
    await act(async () => {
      await api.patch(`/api/admin/streams/${streamId}`, { title });
      setEditingTitle(false);
      notify("Titolo aggiornato.");
    });
  }

  async function uploadPoster(streamId: string, file: File) {
    await act(async () => {
      await uploadStreamImage(streamId, "poster", file);
      notify("Immagine evento aggiornata.");
    });
  }

  async function logout() {
    try {
      await api.post("/api/auth/logout");
    } finally {
      navigate("/login", true);
    }
  }

  function pickPoster(streamId: string) {
    setPosterTarget(streamId);
    posterInput.current?.click();
  }

  if (!me) {
    return (
      <div className="loading-page">
        <span className="spinner" aria-label="Caricamento" />
      </div>
    );
  }

  const active = ov?.stream ?? null;
  // The dashboard always shows the most recent broadcast — live, draft or
  // ended — because that is the one an operator is preparing or has just run.
  const current = active ?? streams[0] ?? null;

  return (
    <div className="admin">
      <input
        ref={posterInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file && posterTarget) void uploadPoster(posterTarget, file);
          event.target.value = "";
        }}
      />

      <header className="admin-top">
        <BrandMark name={brand} />
        <div className="admin-user">
          <button
            className="icon-btn"
            title="Impostazioni"
            aria-label="Impostazioni"
            onClick={() => navigate("/admin/settings")}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
            </svg>
          </button>

          <div className="avatar-menu" onClick={(event) => event.stopPropagation()}>
            <button className="avatar" onClick={() => setMenuOpen((open) => !open)} aria-label="Menu utente">
              {initials(me.username)}
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <span>{me.username}</span>
                  <span className="pill">{me.role === "admin" ? "admin" : "conduttore"}</span>
                </div>
                <button className="menu-item" onClick={() => void logout()}>
                  Esci
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}
      {toast && <div className="banner banner-ok">{toast}</div>}

      <section className="card">
        <div className="card-head">
          <h2>Diretta</h2>
          <span className={`pill ${active ? (ov?.stream?.status ?? "") : current ? "draft" : "off"}`}>
            {active ? statusLabel(ov) : current ? (current.status === "draft" ? "Bozza" : "Terminata") : "Offline"}
          </span>
        </div>

        {current ? (
          <div className="stack">
            <div className="row-between">
              <div className="row" style={{ alignItems: "flex-start" }}>
                {current.posterUrl ? (
                  <img className="thumb poster-thumb" src={current.posterUrl} alt="" />
                ) : (
                  <span className="thumb poster-thumb placeholder" aria-hidden />
                )}
                <div>
                  {editingTitle ? (
                    <form
                      className="row wrap"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void patchTitle(current.id, titleDraft);
                      }}
                    >
                      <input
                        className="input"
                        value={titleDraft}
                        maxLength={120}
                        autoFocus
                        onChange={(e) => setTitleDraft(e.target.value)}
                      />
                      <button className="btn btn-primary btn-small" type="submit" disabled={busy || !titleDraft.trim()}>
                        Salva
                      </button>
                      <button className="btn btn-ghost btn-small" type="button" onClick={() => setEditingTitle(false)}>
                        Annulla
                      </button>
                    </form>
                  ) : (
                    <>
                      <p className="stream-title">{current.title}</p>
                      <p className="muted small mono">
                        {current.slug} · {kindLabel(current.kind)}
                      </p>
                    </>
                  )}
                </div>
              </div>
              <div className="row wrap">
                <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => pickPoster(current.id)}>
                  {current.posterUrl ? "Cambia immagine" : "Carica immagine"}
                </button>
                <button
                  className="btn btn-ghost btn-small"
                  disabled={busy}
                  onClick={() => {
                    setTitleDraft(current.title);
                    setEditingTitle(true);
                  }}
                >
                  Modifica
                </button>
                {current.status !== "draft" && (
                  <button
                    className="btn btn-ghost btn-small"
                    onClick={() => void copyToClipboard(current.pageUrl).then(() => notify("Link copiato."))}
                  >
                    Copia link
                  </button>
                )}
                {active ? (
                  <button className="btn btn-danger btn-small" disabled={busy} onClick={() => void stopStream(active.id)}>
                    Termina
                  </button>
                ) : (
                  <button className="btn btn-primary btn-small" disabled={busy} onClick={() => void startStream(current.id)}>
                    Vai in onda
                  </button>
                )}
              </div>
            </div>

            {active && (
              <p className="muted small">
                In onda dalle {formatTime(active.startedAt)} · {active.record ? "registrazione attiva" : "nessuna registrazione"}
              </p>
            )}
            {!current.posterUrl && (
              <p className="muted small">
                Carica l'immagine evento: è quello che gli spettatori vedono prima di premere play.
              </p>
            )}

            {active && <ObsPanel ov={ov} />}
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
                <th aria-label="immagine" />
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
                    {s.iconUrl ? (
                      <img className="thumb icon-thumb" src={s.iconUrl} alt="" />
                    ) : s.posterUrl ? (
                      <img className="thumb icon-thumb" src={s.posterUrl} alt="" />
                    ) : (
                      <span className="thumb icon-thumb placeholder" aria-hidden />
                    )}
                  </td>
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
                    <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => pickPoster(s.id)}>
                      Immagine
                    </button>
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

      <SettingsPanel notify={notify} />
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
        placeholder="Titolo della diretta (es. Congresso Regionale / Evento semestrale)"
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
      setRevealed(await api.get<{ server: string; backupServer?: string; streamKey: string }>("/api/admin/ingest"));
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
        In uso: <b>{ov.ingest.currentInput ? using : "—"}</b>. Se l'encoder principale si interrompe, la regia ripassa
        da sola sul backup in pochi secondi.
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

function SettingsPanel({ notify }: { notify: (m: string) => void }) {
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    </section>
  );
}
