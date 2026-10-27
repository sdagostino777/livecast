import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * The install's display name, editable from the panel (Configurazione) and
 * served by the public /api/brand endpoint so the login page has it too.
 * The fallback keeps the page useful before the request resolves.
 */
export function useBrand(): string {
  const [name, setName] = useState("Livecast");
  useEffect(() => {
    let alive = true;
    api
      .get<{ name: string }>("/api/brand")
      .then((res) => {
        if (!alive) return;
        setName(res.name);
        document.title = res.name;
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
