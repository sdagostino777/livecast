import { useEffect, useState } from "react";
import { api, ApiError, LiveMeta } from "../api";
import { useBrand } from "../brand";
import { MediaPlayer } from "../components/MediaPlayer";
import { BrandMark } from "../components/BrandMark";

/**
 * The viewer page. It polls the status endpoint because a shared link can be
 * opened before the operator goes on air, and people should not have to reload
 * when the show starts.
 */
export function Player({ slug }: { slug: string }) {
  const brand = useBrand();
  const [meta, setMeta] = useState<LiveMeta | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  // One heartbeat per open page; the panel counts the ones seen in the last
  // minute, so nothing needs cleaning up when a tab is closed.
  useEffect(() => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let alive = true;
    const beat = () => {
      if (!alive || document.hidden) return;
      void fetch(`/api/live/${slug}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
        keepalive: true,
      }).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, 20000);
    const onVisible = () => {
      if (!document.hidden) beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug]);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const next = await api.get<LiveMeta>(`/api/live/${slug}`);
        if (!alive) return;
        setMeta(next);
        setNotFound(false);
        setUnreachable(false);
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          setMeta(null);
        } else {
          setUnreachable(true);
        }
      }
    }
    void tick();
    const timer = window.setInterval(tick, 8000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [slug]);

  // The tab names the event and the service that is broadcasting it.
  useEffect(() => {
    if (!meta) return;
    document.title = `${meta.title} · ${brand}`;
  }, [meta?.title, brand]); // eslint-disable-line react-hooks/exhaustive-deps

  if (notFound) {
    return (
      <div className="player-page">
        <div className="player-missing" style={{ margin: "auto", padding: 24 }}>
          <p className="player-message-title">Diretta non trovata</p>
          <p className="muted">Controlla il link che ti hanno inviato.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="player-page">
      <main className="player-main">
        <MediaPlayer
          // A kind change replaces the media element: remount so hls.js is not
          // left attached to the <video> that no longer exists.
          key={meta?.kind ?? "video"}
          hlsUrl={meta?.hlsUrl ?? null}
          kind={meta?.kind ?? "video"}
          live={meta?.status === "live"}
          ended={meta?.status === "ended"}
          title={meta?.title ?? ""}
          brand={brand}
          posterUrl={meta?.posterUrl ?? meta?.fallbackPosterUrl ?? null}
        />
      </main>
      <footer className="player-footer">
        {unreachable ? (
          <span className="small">Riconnessione al server…</span>
        ) : (
          <BrandMark name={brand} size={28} />
        )}
      </footer>
    </div>
  );
}
