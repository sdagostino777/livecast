import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";

export interface VideoPlayerProps {
  /** Absolute or same-origin HLS master playlist URL; null until the stream is live. */
  hlsUrl: string | null;
  live: boolean;
  ended: boolean;
  title: string;
}

type PlayerState = "idle" | "loading" | "playing" | "paused" | "error";

/**
 * The viewer. One job: play and pause.
 *
 * No seekbar, no volume slider, no quality picker — a live broadcast has no
 * timeline to seek, and mobile volume is a hardware button. What it does keep is
 * everything that makes a live stream feel alive: it reconnects on its own, it
 * says "not started yet" before air time, and it says "ended" after.
 */
export function VideoPlayer({ hlsUrl, live, ended, title }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
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

  // The stream can start and end while the page is open.
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
    const video = videoRef.current;
    if (video) {
      video.removeAttribute("src");
      video.load();
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
    const video = videoRef.current;
    if (!video) return;
    setState("loading");
    retries.current += 1;

    try {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // iOS Safari plays HLS natively. This is the single most important
        // compatibility branch in the whole app: it is the one path that also
        // keeps working in low-power mode.
        if (video.src !== hlsUrl) video.src = hlsUrl;
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
        hls.attachMedia(video);
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error("manifest timeout")), 15000);
          hls.once(Hls.Events.MANIFEST_PARSED, () => {
            window.clearTimeout(timer);
            resolve();
          });
        });
      }
      await video.play();
      setState("playing");
    } catch {
      if (!destroyed.current) {
        setState("error");
        scheduleRetry();
      }
    }
  }

  function toggle() {
    const video = videoRef.current;
    if (!video) return;
    if (state === "playing") {
      video.pause();
      setState("paused");
    } else if (state === "paused" || state === "idle" || state === "error") {
      void start();
    }
  }

  const showOverlay = state !== "playing";
  const notStarted = !live && !ended;

  return (
    <div className="player-frame" data-live={live ? "true" : "false"}>
      <video
        ref={videoRef}
        className="player-video"
        playsInline
        preload="none"
        onClick={toggle}
        aria-label={title}
      />

      <div className="player-top">
        {live && <span className="live-badge">LIVE</span>}
        <span className="player-title">{title}</span>
      </div>

      {showOverlay && (
        <div className="player-overlay">
          {notStarted && (
            <div className="player-message">
              <p className="player-message-title">La diretta non è ancora iniziata</p>
              <p className="muted small">Torna qui all'orario previsto.</p>
            </div>
          )}

          {ended && (
            <div className="player-message">
              <p className="player-message-title">Questa diretta è terminata</p>
            </div>
          )}

          {!ended && state === "loading" && <span className="spinner" aria-label="Caricamento" />}

          {!ended && state === "error" && (
            <div className="player-message">
              <p className="player-message-title">Segnale non disponibile</p>
              <p className="muted small">Nuovo tentativo in corso…</p>
            </div>
          )}

          {!ended && !notStarted && (state === "idle" || state === "paused" || state === "error") && (
            <button className="play-button" onClick={toggle} aria-label={state === "paused" ? "Riprendi" : "Riproduci"}>
              <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden>
                <path d="M8 5v14l11-7z" fill="currentColor" />
              </svg>
            </button>
          )}
        </div>
      )}

      <div className="player-controls">
        <button
          className="control-button"
          onClick={toggle}
          disabled={notStarted || ended}
          aria-label={state === "playing" ? "Pausa" : "Riproduci"}
        >
          {state === "playing" ? (
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
    </div>
  );
}
