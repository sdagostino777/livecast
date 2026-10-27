import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * The install's display name, editable from the panel (Configurazione) and
 * served by the public /api/brand endpoint so the login page has it too.
 * The fallback keeps the page useful before the request resolves.
 */
/**
 * The install's logo, when the operator uploaded one. Null means "use the
 * generated mark", which is what a fresh clone shows.
 */
export function useBrandLogo(): string | null {
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .get<{ logoUrl: string | null }>("/api/brand")
      .then((res) => alive && setLogo(res.logoUrl))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return logo;
}

export function useBrand(): string {
  const [name, setName] = useState("Livecast");
  useEffect(() => {
    let alive = true;
    api
      .get<{ name: string; logoUrl: string | null }>("/api/brand")
      .then((res) => {
        if (!alive) return;
        setName(res.name);
        document.title = res.name;
        // The tab shows the operator's logo, not ours.
        const tabIcon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
        if (tabIcon && res.logoUrl) tabIcon.href = res.logoUrl;
      })
      .catch(() => {
        /* keep the fallback */
      });
    return () => {
      alive = false;
    };
  }, []);
  return name;
}
