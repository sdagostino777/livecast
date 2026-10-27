import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  Checks,
  Me,
  Overview,
  posterSrc,
  removeBrandLogo,
  Settings,
  StreamView,
  uploadBrandLogo,
  uploadStreamImage,
} from "../api";
import { useBrand } from "../brand";
import { ForcePasswordChange } from "../components/ForcePasswordChange";
import { BrandMark } from "../components/BrandMark";
import { copyToClipboard, navigate } from "../router";

function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return "Sessione scaduta: accedi di nuovo.";
      case 403:
        return "Operazione riservata all'amministratore.";
      case 409:
        return "Operazione non possibile mentre la diretta è in onda.";
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

function statusLabel(ov: Overview | null): string {
  if (!ov?.stream) return "Pronta";
  if (ov.stream.status === "starting") return ov.ingest.ready ? "Preparazione…" : "In attesa del segnale";
  if (ov.stream.status === "live") return "In onda";
  return "Pronta";
}

function initials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

const PALETTES: Array<{ value: string; label: string; css: string }> = [
  { value: "blue", label: "Blu", css: "linear-gradient(135deg,#0f3559,#2a6cb6)" },
  { value: "teal", label: "Petrolio", css: "linear-gradient(135deg,#0b3b4a,#1d7a8c)" },
  { value: "indigo", label: "Indaco", css: "linear-gradient(135deg,#1e1a4d,#4f46a5)" },
  { value: "slate", label: "Ardesia", css: "linear-gradient(135deg,#12212e,#3f6076)" },
  { value: "plum", label: "Prugna", css: "linear-gradient(135deg,#3a1f3d,#8d4a63)" },
];

export function Admin() {
  const brand = useBrand();
  const [me, setMe] = useState<Me["user"] | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [current, setCurrent] = useState<StreamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const toastTimer = useRef<number | null>(null);
  const [pubKind, setPubKind] = useState<null | "camera" | "screen">(null);
  const [pubError, setPubError] = useState<string | null>(null);
  const [leavePrompt, setLeavePrompt] = useState<(() => void) | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const pubPc = useRef<RTCPeerConnection | null>(null);
  const pubMedia = useRef<MediaStream | null>(null);
  const pubVideo = useRef<HTMLVideoElement | null>(null);
  const [devicePreview, setDevicePreview] = useState<MediaStream | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const testVideo = useRef<HTMLVideoElement | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);

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
      const single = overview.stream ?? streamList.streams[0] ?? null;
      setCurrent(single);
      // Bumping this re-requests the generated artwork, so the preview follows
      // the title/palette the operator just typed.
      setPreviewTick((tick) => tick + 1);
      setTitleDraft((draft) => (draft === "" && single ? single.title : draft));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate("/login", true);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError("Sessione valida ma la password deve essere cambiata: ricarica la pagina.");
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
        if (!who.user.mustChangePassword) await refresh();
      } catch {
        if (alive) navigate("/login", true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  // The panel polls: "Preparazione…" must become "In onda" by itself the moment
  // the first segment lands, without the operator reloading the page.
  useEffect(() => {
    if (!me || me.mustChangePassword) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [me, refresh]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  useEffect(() => {
    if (!pubKind) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pubKind]);

  useEffect(() => {
    if (pubVideo.current && pubMedia.current) pubVideo.current.srcObject = pubMedia.current;
  }, [pubKind]);

  useEffect(() => {
    if (testVideo.current && devicePreview) testVideo.current.srcObject = devicePreview;
  }, [devicePreview]);

  const active = ov?.stream ?? null;
  /** When the current broadcast went on air, for the elapsed-time counter. */
  const onlineSince = ov?.pipeline.startedAt ?? current?.startedAt ?? null;
  const onAir = Boolean(active);

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

  /** Saves the configuration: creates the broadcast the first time, patches later. */
  async function saveConfig(
    title: string,
    kind: "video" | "audio",
    record: boolean,
    files: { poster?: File; icon?: File; palette?: string | null },
  ) {
    await act(async () => {
      let streamId = current?.id ?? null;
      if (!streamId) {
        const created = await api.post<{ stream: StreamView }>("/api/admin/streams", { title, kind, record });
        streamId = created.stream.id;
      } else {
        await api.patch(`/api/admin/streams/${streamId}`, { title, kind, record });
      }
      if (files.palette !== undefined) {
        await api.patch(`/api/admin/streams/${streamId}`, { posterPalette: files.palette });
      }
      if (files.poster) await uploadStreamImage(streamId, "poster", files.poster);
      if (files.icon) await uploadStreamImage(streamId, "icon", files.icon);
      notify("Diretta salvata.");
      setTitleDraft(title);
    });
  }

  /**
   * Starts a new event: a new row with a new link, carrying over the artwork and
   * the palette so the operator does not have to rebuild what they just set.
   */
  async function createNewEvent() {
    if (!current) return;
    await act(async () => {
      const previous = current;
      const carried: Array<{ kind: "poster" | "icon"; name: string; file: Blob }> = [];
      for (const [kind, url] of [
        ["poster", previous.posterImageUrl],
        ["icon", previous.iconUrl],
      ] as const) {
        if (!url) continue;
        const response = await fetch(url);
        if (!response.ok) continue;
        const blob = await response.blob();
        const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
        carried.push({ kind, name: `${kind}.${ext}`, file: blob });
      }
      const created = await api.post<{ stream: StreamView }>("/api/admin/streams", {
        title: titleDraft.trim() || previous.title,
        kind: previous.kind,
        record: previous.record,
      });
      const id = created.stream.id;
      await api.patch(`/api/admin/streams/${id}`, {
        posterPalette: previous.posterPalette,
        posterOverlay: previous.posterOverlay,
      });
      for (const item of carried) {
        await uploadStreamImage(id, item.kind, new File([item.file], item.name, { type: item.file.type }));
      }
      notify("Nuovo evento: il link è cambiato.");
    });
  }

  /**
   * An image chosen for an event that already exists uploads immediately: the
   * panel has no save button, so waiting for one meant nothing happened.
   */
  async function uploadImage(kind: "poster" | "icon", file: File) {
    if (!current) return;
    await act(async () => {
      await uploadStreamImage(current.id, kind, file);
      notify(kind === "poster" ? "Immagine caricata." : "Icona caricata.");
    });
  }

  /** Live-updating configuration: the panel has no save button any more. */
  async function autoSaveConfig(patch: {
    title?: string;
    kind?: "video" | "audio";
    record?: boolean;
    posterPalette?: string | null;
    posterOverlay?: boolean;
  }) {
    if (!current) return; // the first save uses the create button
    try {
      await api.patch(`/api/admin/streams/${current.id}`, patch);
      if (patch.title) setTitleDraft(patch.title);
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  async function startStream() {
    if (!current) return;
    await act(async () => {
      await api.post(`/api/admin/streams/${current.id}/start`);
      notify("In onda.");
    });
  }

  async function stopStream() {
    if (!current) return;
    await act(async () => {
      await api.post(`/api/admin/streams/${current.id}/stop`);
      notify("Diretta terminata.");
    });
  }

  /** Local check of camera and microphone, before anything goes on air. */
  async function testDevices() {
    setDeviceError(null);
    try {
      const media = devicePreview ?? (await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true }));
      setDevicePreview(media);
      const ctx = new AudioContext();
      audioCtx.current = ctx;
      const source = ctx.createMediaStreamSource(media);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128));
        setMicLevel(Math.min(100, Math.round((peak / 128) * 160)));
        if (audioCtx.current) requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "permesso negato";
      setDeviceError(`Camera o microfono non disponibili (${detail}).`);
    }
  }

  function stopDeviceTest() {
    audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
    devicePreview?.getTracks().forEach((track) => track.stop());
    setDevicePreview(null);
    setMicLevel(0);
  }

  async function publishFromBrowser(kind: "camera" | "screen") {
    setPubError(null);
    setBusy(true);
    try {
      const ingest = await api.get<{ server: string }>("/api/admin/ingest");
      const parsed = new URL(ingest.server);
      const user = parsed.searchParams.get("user") ?? "";
      const pass = parsed.searchParams.get("pass") ?? "";

      const media =
        kind === "screen"
          ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
          : (devicePreview ?? (await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true })));
      pubMedia.current = media;
      if (pubVideo.current) pubVideo.current.srcObject = media;

      const pc = new RTCPeerConnection();
      pubPc.current = pc;
      media.getTracks().forEach((track) => pc.addTrack(track, media));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch("/live/whip", {
        method: "POST",
        headers: { "content-type": "application/sdp", authorization: `Basic ${btoa(`${user}:${pass}`)}` },
        body: offer.sdp,
      });
      if (!res.ok) throw new Error(`WHIP ${res.status}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
      // The server often reports "peer connection established" before our
      // listener is attached: state is polled, not only observed by event.
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          if (pc.connectionState === "connected") return resolve();
          if (pc.connectionState === "failed") return reject(new Error("failed"));
          if (Date.now() - started > 12000) return reject(new Error("timeout"));
          window.setTimeout(check, 250);
        };
        check();
      });
      setPubKind(kind);
      notify("Dispositivo collegato. Premi ● ONLINE.");
      await refresh();
    } catch (err) {
      stopPublishing();
      const detail = err instanceof Error ? err.message : "errore sconosciuto";
      setPubError(`Impossibile collegare il dispositivo (${detail}). Controlla i permessi del browser per camera e microfono.`);
    } finally {
      setBusy(false);
    }
  }

  function stopPublishing() {
    pubPc.current?.close();
    pubPc.current = null;
    pubMedia.current?.getTracks().forEach((track) => track.stop());
    pubMedia.current = null;
    setPubKind(null);
  }

  /** Anything that leaves the page while on air asks first. */
  function guardLeave(action: () => void) {
    if (!ov?.stream || (ov.stream.status !== "live" && ov.stream.status !== "starting")) {
      action();
      return;
    }
    setLeavePrompt(() => action);
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

  if (me.mustChangePassword) {
    return <ForcePasswordChange username={me.username} isAdmin={me.role === "admin"} />;
  }

  return (
    <div className="admin">
      <header className="admin-top">
        <BrandMark name={brand} />
        <div className="admin-user">
          <button className="icon-btn" title="Impostazioni" aria-label="Impostazioni" onClick={() => guardLeave(() => navigate("/admin/settings"))}>
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
                <button className="menu-item" onClick={() => guardLeave(() => void logout())}>
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
          <span className={`pill ${active ? active.status : "off"}`}>
            {active?.status === "starting" && <span className="spinner-xs" aria-hidden />}
            {active?.status === "live" && <span className="blink-dot" aria-hidden />}
            {statusLabel(ov)}
          </span>
          {active && (
            <span className="pill viewers" title="Persone collegate in questo momento">
              {ov?.viewers ?? 0} {(ov?.viewers ?? 0) === 1 ? "collegato" : "collegati"}
            </span>
          )}
        </div>

        {current && (
          <div className="share-row">
            <span className="small muted">Link della diretta</span>
            <code className="code share-url">{current.pageUrl}</code>
            <button
              className="btn btn-primary"
              onClick={() => void copyToClipboard(current.pageUrl).then(() => notify("Link copiato."))}
            >
              Copia link
            </button>
          </div>
        )}

        <BroadcastConfig
          previewTick={previewTick}
          current={current}
          onAir={onAir}
          busy={busy}
          titleDraft={titleDraft}
          setTitleDraft={setTitleDraft}
          onAutoSave={autoSaveConfig}
          onCreate={saveConfig}
          onNewEvent={createNewEvent}
          onUploadImage={uploadImage}
        />

        <hr className="sep" />

        <div className="regia">
          {pubKind ? (
            <div className="regia-preview-wrap">
              <video ref={pubVideo} autoPlay muted playsInline className="regia-preview" />
              {onAir && (
                <span className="live-corner" aria-label="in onda">
                  <span className="blink-dot" aria-hidden /> LIVE
                </span>
              )}
            </div>
          ) : (
            <div className="regia-preview empty">
              <span className="small">Anteprima non attiva</span>
            </div>
          )}
          <div className="regia-actions">
            <button
              className="btn btn-online"
              disabled={busy || onAir || !(pubKind !== null || ov?.ingest.ready) || !current}
              onClick={() => void startStream()}
              title={pubKind !== null || ov?.ingest.ready ? "Manda in onda" : "Collega prima camera o schermo"}
            >
              {busy && !onAir ? <span className="spinner-xs" aria-hidden /> : "●"} ONLINE
            </button>
            <button className="btn btn-stop" disabled={busy || !onAir} onClick={() => void stopStream()} title="Ferma la diretta">
              ■ STOP
            </button>

            <div className="sep" style={{ margin: "10px 0" }} />

            {pubKind === null ? (
              <div className="stack" style={{ gap: 10 }}>
                <div className="row wrap">
                  <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => void testDevices()}>
                    {devicePreview ? "Riprova dispositivi" : "Verifica camera e microfono"}
                  </button>
                  {devicePreview && (
                    <button className="btn btn-ghost btn-small" disabled={busy} onClick={stopDeviceTest}>
                      Chiudi prova
                    </button>
                  )}
                </div>
                {devicePreview && (
                  <div className="device-check">
                    <video ref={testVideo} autoPlay muted playsInline className="device-preview" />
                    <div className="stack" style={{ gap: 6, flex: 1 }}>
                      <span className="small muted">Microfono</span>
                      <div className="mic-meter">
                        <span style={{ width: `${micLevel}%` }} />
                      </div>
                      <span className="small muted">
                        {micLevel > 3 ? "Il microfono sta ricevendo audio" : "Parla: la barra deve muoversi"}
                      </span>
                    </div>
                  </div>
                )}
                {deviceError && <p className="error-text small">{deviceError}</p>}
                <div className="row wrap">
                <button className="btn btn-ghost btn-small" disabled={busy || !current} onClick={() => void publishFromBrowser("camera")}>
                  Collega camera
                </button>
                <button className="btn btn-ghost btn-small" disabled={busy || !current} onClick={() => void publishFromBrowser("screen")}>
                  Collega schermo
                </button>
                  {onAir && <OnlineTimer startedAt={onlineSince} />}
                </div>
              </div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                <span className="small">
                  {pubKind === "camera" ? "Camera" : "Schermo"} collegato — <b>{onAir ? "in onda" : "anteprima"}</b>
                  {!onAir && ": nessuno ti vede finché non premi ● ONLINE"}
                </span>
                <div className="row wrap">
                  <button className="btn btn-ghost btn-small" disabled={busy} onClick={stopPublishing}>
                    Scollega
                  </button>
                  {onAir && <OnlineTimer startedAt={onlineSince} />}
                </div>
              </div>
            )}
            <p className="muted small" style={{ margin: 0 }}>
              La pagina deve restare aperta durante la trasmissione: se la ricarichi, la diretta si interrompe.
            </p>
            {pubError && <p className="error-text small">{pubError}</p>}
          </div>
        </div>

        {onAir && (
          <p className="muted small" style={{ marginTop: 12 }}>
            <span className="blink-dot" aria-hidden /> In onda: lascia aperta questa pagina finché la diretta non è
            finita.
          </p>
        )}

        {onAir && <ExternalEncoderPanel ov={ov} />}
      </section>

      <SettingsPanel notify={notify} />
      <MaintenancePanel notify={notify} />

      {leavePrompt && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal card">
            <h2 style={{ marginTop: 0 }}>Uscire dalla pagina?</h2>
            <p className="muted small">
              La trasmissione è in corso. Se esci o ricarichi, <b>la diretta cade</b> e gli spettatori restano senza
              segnale.
            </p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-online" onClick={() => setLeavePrompt(null)}>
                Resta in onda
              </button>
              <button
                className="btn btn-stop"
                onClick={() => {
                  const action = leavePrompt;
                  setLeavePrompt(null);
                  action();
                }}
              >
                Esci comunque
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BroadcastConfig({
  previewTick,
  current,
  onAir,
  busy,
  titleDraft,
  setTitleDraft,
  onAutoSave,
  onCreate,
  onNewEvent,
  onUploadImage,
}: {
  previewTick: number;
  current: StreamView | null;
  onAir: boolean;
  busy: boolean;
  titleDraft: string;
  setTitleDraft: (value: string) => void;
  onAutoSave: (patch: {
    title?: string;
    kind?: "video" | "audio";
    record?: boolean;
    posterPalette?: string | null;
  }) => Promise<void>;
  onCreate: (
    title: string,
    kind: "video" | "audio",
    record: boolean,
    files: { poster?: File; icon?: File; palette?: string | null },
  ) => Promise<void>;
  onNewEvent: () => Promise<void>;
  onUploadImage: (kind: "poster" | "icon", file: File) => Promise<void>;
}) {
  const [kind, setKind] = useState<"video" | "audio">("video");
  const [record, setRecord] = useState(false);
  const [palette, setPalette] = useState<string | null>(null);
  const [posterFile, setPosterFile] = useState<File | null>(null);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [posterPreview, setPosterPreview] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(false);
  const posterRef = useRef<HTMLInputElement | null>(null);
  const saveTimer = useRef<number | null>(null);

  /** Everything here saves itself: the panel has no "Salva" button. */
  function autoSave(patch: {
    title?: string;
    kind?: "video" | "audio";
    record?: boolean;
    posterPalette?: string | null;
    posterOverlay?: boolean;
  }) {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void onAutoSave(patch);
    }, 600);
  }

  useEffect(() => {
    if (!current) return;
    setKind(current.kind);
    setRecord(current.record);
    setPalette(current.posterPalette);
    setOverlay(current.posterOverlay);
    setTitleDraft(current.title);
  }, [current?.id, current?.kind, current?.record, current?.posterPalette, current?.posterOverlay, current?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!titleDraft.trim() || current) return;
    await onCreate(titleDraft.trim(), kind, record, {
      ...(posterFile ? { poster: posterFile } : {}),
      ...(iconFile ? { icon: iconFile } : {}),
      palette,
    });
    setPosterFile(null);
    setIconFile(null);
    if (posterPreview) URL.revokeObjectURL(posterPreview);
    setPosterPreview(null);
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="row wrap">
        <input
          className="input grow"
          placeholder="Titolo — es. Congresso Regionale / Evento semestrale"
          value={titleDraft}
          maxLength={120}
          autoFocus
          disabled={onAir}
          onChange={(e) => {
            setTitleDraft(e.target.value);
            autoSave({ title: e.target.value });
          }}
        />
        <div className="choice" role="radiogroup" aria-label="Tipo di trasmissione">
          <label>
            <input
              type="radio"
              name="kind"
              checked={kind === "video"}
              disabled={onAir}
              onChange={() => {
                setKind("video");
                autoSave({ kind: "video" });
              }}
            />
            Video
          </label>
          <label>
            <input
              type="radio"
              name="kind"
              checked={kind === "audio"}
              disabled={onAir}
              onChange={() => {
                setKind("audio");
                autoSave({ kind: "audio" });
              }}
            />
            Solo audio
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={record}
            disabled={onAir}
            onChange={(e) => {
              setRecord(e.target.checked);
              autoSave({ record: e.target.checked });
            }}
          />
          Registra
        </label>
      </div>

      <div className="row wrap" style={{ alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 8, flex: 1, minWidth: 240 }}>
          <span className="small muted">Sfondo del titolo (se non carichi un'immagine)</span>
          <div className="row wrap">
            {PALETTES.map((option) => (
              <button
                key={option.value}
                type="button"
                title={option.label}
                aria-label={option.label}
                disabled={onAir}
                className={`swatch${palette === option.value ? " active" : ""}`}
                style={{ background: option.css }}
                onClick={() => {
                  setPalette(option.value);
                  autoSave({ posterPalette: option.value });
                }}
              />
            ))}
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={onAir}
              onClick={() => {
                setPalette(null);
                autoSave({ posterPalette: null });
              }}
            >
              Automatico
            </button>
          </div>
          <span className="small muted">oppure carica un'immagine: sostituisce lo sfondo</span>
          <div className="row wrap">
            <input
              ref={posterRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                event.target.value = "";
                if (!file) return;
                setPosterFile(file);
                if (posterPreview) URL.revokeObjectURL(posterPreview);
                setPosterPreview(URL.createObjectURL(file));
                if (current) {
                  void onUploadImage("poster", file).then(() => {
                    setPosterFile(null);
                    setPosterPreview((preview) => {
                      if (preview) URL.revokeObjectURL(preview);
                      return null;
                    });
                  });
                }
              }}
            />
            <button type="button" className="btn btn-ghost btn-small" disabled={onAir} onClick={() => posterRef.current?.click()}>
              {posterFile || current?.posterImageUrl ? "Cambia immagine" : "Carica immagine"}
            </button>
            <label className="btn btn-ghost btn-small" style={{ cursor: onAir ? "not-allowed" : "pointer" }}>
              {current?.iconUrl ? "Cambia icona" : "Carica icona"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                disabled={onAir}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  event.target.value = "";
                  if (!file) return;
                  if (current) void onUploadImage("icon", file);
                  else setIconFile(file);
                }}
              />
            </label>
          </div>
          {(posterFile || current?.posterImageUrl) && (
            <label className="check">
              <input
                type="checkbox"
                checked={overlay}
                disabled={onAir || (!posterFile && !current?.posterImageUrl)}
                onChange={(event) => {
                  setOverlay(event.target.checked);
                  autoSave({ posterOverlay: event.target.checked });
                }}
              />
              Mostra il nome dell'evento sopra l'immagine
            </label>
          )}
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="small muted">Anteprima</span>
          <div className="poster-wrap">
            <img
              className="thumb poster-thumb big"
              src={posterPreview ?? (current ? `${posterSrc(current)}?v=${previewTick}` : undefined)}
              alt=""
            />
            {onAir && (
              <span className="onair-badge">
                <span className="blink-dot" aria-hidden /> IN ONDA
              </span>
            )}
          </div>
          {current && (
            <span className="row" style={{ gap: 8, alignItems: "center" }}>
              <img className="thumb icon-thumb" src={`${current.adminIconUrl}?v=${previewTick}`} alt="Icona dell'evento" />
              <span className="small muted">Icona</span>
            </span>
          )}
        </div>

        {!current && (
          <div className="stack" style={{ gap: 8 }}>
            <button className="btn btn-primary" type="submit" disabled={busy || !titleDraft.trim()}>
              Crea diretta
            </button>
          </div>
        )}

        {current?.status === "ended" && (
          <div className="stack" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={busy || !titleDraft.trim()}
              onClick={() => void onNewEvent()}
            >
              Nuovo evento (link nuovo)
            </button>
            <span className="small muted" style={{ margin: 0 }}>
              Ogni evento ha il suo link: questo ne genera uno nuovo e archivia il precedente.
            </span>
          </div>
        )}
      </div>
    </form>
  );
}

/**
 * Elapsed time on air. Small, right-aligned, and it counts from the moment the
 * pipeline started — not from when the page was opened.
 */
function OnlineTimer({ startedAt }: { startedAt: string | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!startedAt) return null;
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const seconds = String(elapsed % 60).padStart(2, "0");
  const minutes = String(Math.floor(elapsed / 60) % 60).padStart(2, "0");
  const hours = Math.floor(elapsed / 3600);
  return (
    <span className="online-timer" title="Tempo in onda" aria-label="tempo in onda">
      <span className="blink-dot" aria-hidden />
      {hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`}
    </span>
  );
}

function ExternalEncoderPanel({ ov }: { ov: Overview | null }) {
  const [revealed, setRevealed] = useState<{ server: string; backupServer?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!ov) return null;
  return (
    <div className="obs">
      <div className="obs-head">
        <span className={`dot ${ov.ingest.ready ? "on" : "off"}`} aria-hidden />
        <span className="small">Dispositivo/encoder collegato: {ov.ingest.ready ? "sì" : "no"}</span>
        <span className={`dot ${ov.ingest.backupReady ? "on" : "off"}`} aria-hidden />
        <span className="small">backup: {ov.ingest.backupReady ? "sì" : "no"}</span>
      </div>
      <p className="small" style={{ margin: 0 }}>
        Vuoi usare un programma esterno invece della camera del browser? Incolla l'URL completo nel campo Server (chiave
        di trasmissione vuota).
      </p>
      {revealed ? (
        <>
          <div className="code-row">
            <code className="code">{revealed.server}</code>
            <button className="btn btn-ghost btn-small" onClick={() => void copyToClipboard(revealed.server)}>
              Copia
            </button>
          </div>
          <button className="btn btn-ghost btn-small" onClick={() => setRevealed(null)}>
            Nascondi
          </button>
        </>
      ) : (
        <button
          className="btn btn-ghost btn-small"
          disabled={busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              try {
                setRevealed(await api.get<{ server: string; backupServer?: string }>("/api/admin/ingest"));
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          Mostra credenziali
        </button>
      )}
    </div>
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
      notify("Logo aggiornato.");
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
      const tabIcon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (tabIcon && logoUrl) tabIcon.href = `${logoUrl}?v=${logoVersion}`;
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
            <em className="muted">PNG quadrato consigliato (512×512). Senza logo resta il simbolo generato.</em>
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
