import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";

export interface MediaPlayerProps {
  /** Absolute or same-origin HLS master playlist URL; null until the stream is live. */
  hlsUrl: string | null;
  kind: "video" | "audio";
  live: boolean;
  ended: boolean;
  title: string;
  brand: string;
}

type PlayerState = "idle" | "loading" | "playing" | "paused" | "error";

/**
 * The viewer. One job: play and pause.
 *
 * Both kinds share the same attach/retry machinery and differ only in what is
 * painted around the media element: a video frame, or an audio card with a
 * play button and an equaliser that moves only while sound is actually coming
 * out of the device.
 */
export function MediaPlayer({ hlsUrl, kind, live, ended, title, brand }: MediaPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const retryTimer = useRef<number | null>(null);
  const retries = useRef(0);
  const destroyed = useRef(false);

  const [state, setState] = useState<PlayerState>("idle");

  useEffect(() => {
    return () => {
      destroyed.current = true;
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (ended) {
      teardown();
      setState("idle");
    }
    if (!live && !ended) teardown();
  }, [ended, live]);

  function teardown() {
    if (retryTimer.current) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    retries.current = 0;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const media = mediaRef.current;
    if (media) {
      media.removeAttribute("src");
      media.load();
    }
  }

  function scheduleRetry() {
    if (!live || destroyed.current) return;
    if (retries.current >= 20) return; // ~1 minute of attempts, then let the user press play
    retries.current += 1;
    retryTimer.current = window.setTimeout(() => {
      void start();
    }, 3000);
  }

  async function start() {
    if (!hlsUrl || destroyed.current) return;
    const media = mediaRef.current;
    if (!media) return;
    setState("loading");
    retries.current += 1;

    try {
      if (media.canPlayType("application/vnd.apple.mpegurl")) {
        // iOS Safari plays HLS natively, audio included.
        if (media.src !== hlsUrl) media.src = hlsUrl;
      } else {
        hlsRef.current?.destroy();
        // hls.js is dropped from the main bundle on purpose: the viewer page is
        // the one page opened on mobile data, and the library is only needed the
        // moment the visitor presses play.
        const { default: Hls } = await import("hls.js");
        const hls = new Hls({
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 20,
          liveDurationInfinity: true,
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          setState("error");
          hls.destroy();
          hlsRef.current = null;
          scheduleRetry();
        });
        hls.loadSource(hlsUrl);
        hls.attachMedia(media);
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error("manifest timeout")), 15000);
          hls.once(Hls.Events.MANIFEST_PARSED, () => {
            window.clearTimeout(timer);
            resolve();
          });
        });
      }
      await media.play();
      setState("playing");
    } catch {
      if (!destroyed.current) {
        setState("error");
        scheduleRetry();
      }
    }
  }

  function toggle() {
    const media = mediaRef.current;
    if (!media) return;
    if (state === "playing") {
      media.pause();
      setState("paused");
    } else if (state === "paused" || state === "idle" || state === "error") {
      void start();
    }
  }

  const notStarted = !live && !ended;
  const playing = state === "playing";

  const mediaProps = {
    playsInline: true,
    preload: "none" as const,
    onPlaying: () => setState("playing"),
    onPause: () => {
      // The media element also pauses on its own at the end of a live window;
      // only surface "paused" when the user did it.
      if (!destroyed.current) setState((s) => (s === "loading" ? s : "paused"));
    },
    onWaiting: () => setState((s) => (s === "playing" ? "loading" : s)),
    onError: () => setState("error"),
  };

  const overlay = notStarted ? (
    <div className="player-overlay">
      <div className="player-message">
        <p className="player-message-title">La diretta non è ancora iniziata</p>
        <p className="muted small">Torna qui all'orario previsto.</p>
      </div>
    </div>
  ) : ended ? (
    <div className="player-overlay">
      <div className="player-message">
        <p className="player-message-title">Questa diretta è terminata</p>
      </div>
    </div>
  ) : state === "loading" ? (
    <div className="player-overlay">
      <span className="spinner" aria-label="Caricamento" />
    </div>
  ) : state === "error" ? (
    <div className="player-overlay">
      <div className="player-message">
        <p className="player-message-title">Segnale non disponibile</p>
        <p className="muted small">Nuovo tentativo in corso…</p>
      </div>
    </div>
  ) : null;

  return (
    <div className={`player-frame${kind === "audio" ? " audio" : ""}`}>
      {kind === "audio" ? (
        <audio
          ref={(el) => {
            mediaRef.current = el;
          }}
          className="player-audio"
          aria-label={title}
          {...mediaProps}
        />
      ) : (
        <video
          ref={(el) => {
            mediaRef.current = el;
          }}
          className="player-video"
          aria-label={title}
          onClick={toggle}
          {...mediaProps}
        />
      )}

      <div className="player-top">
        {live && <span className="live-badge">LIVE</span>}
        <span className="player-title">{title}</span>
      </div>

      {kind === "audio" ? (
        <div className="audio-card">
          <div className="audio-icon" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 9v6h4l5 4V5L8 9H4z" strokeLinejoin="round" />
              <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" strokeLinecap="round" />
            </svg>
          </div>
          <p className="audio-title">{title}</p>
          <p className="audio-sub">Trasmissione solo audio · {brand}</p>
          <div className={`equalizer${playing ? "" : " paused"}`} aria-hidden>
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          {state === "idle" || state === "paused" || state === "error" ? (
            <button className="play-button" onClick={toggle} aria-label="Riproduci">
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M8 5v14l11-7z" fill="currentColor" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {(state === "idle" || state === "paused") && !notStarted && !ended && (
            <div className="player-overlay">
              <button className="play-button" onClick={toggle} aria-label={state === "paused" ? "Riprendi" : "Riproduci"}>
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M8 5v14l11-7z" fill="currentColor" />
                </svg>
              </button>
            </div>
          )}
          {overlay}
        </>
      )}

      {kind === "audio" && overlay}

      {kind === "video" && (
        <div className="player-controls">
          <button
            className="control-button"
            onClick={toggle}
            disabled={notStarted || ended}
            aria-label={playing ? "Pausa" : "Riproduci"}
          >
            {playing ? (
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path d="M8 5v14l11-7z" fill="currentColor" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
