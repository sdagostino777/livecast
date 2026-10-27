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
          hlsUrl={meta?.hlsUrl ?? null}
          kind={meta?.kind ?? "video"}
          live={meta?.status === "live"}
          ended={meta?.status === "ended"}
          title={meta?.title ?? ""}
          brand={brand}
        />
      </main>
      <footer className="player-footer">
        <span className="small">{unreachable ? "Riconnessione al server…" : meta ? <BrandMark name={brand} size={26} /> : brand}</span>
      </footer>
    </div>
  );
}
