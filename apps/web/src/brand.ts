import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * The install's identity, editable from the panel and served by the public
 * /api/brand endpoint so the login page and the player have it too.
 *
 * It lives in a module-level snapshot with subscribers: renaming the service in
 * the settings must change the header of the page the operator is looking at,
 * not only the next reload. Nothing here knows the name "Livecast" — that is
 * just the fallback before the request resolves.
 */
export interface BrandIdentity {
  name: string;
  logoUrl: string | null;
}

/** The play symbol the project ships with, restored when no logo is uploaded. */
const DEFAULT_TAB_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230a0a0a'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23ff3b30'/%3E%3Cpath d='M13 12.5 21 16l-8 3.5z' fill='white'/%3E%3C/svg%3E";

let snapshot: BrandIdentity = { name: "Livecast", logoUrl: null };
let loaded = false;
const listeners = new Set<(identity: BrandIdentity) => void>();

function publish(next: Partial<BrandIdentity>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener(snapshot);
}

/** The tab icon follows the install's logo, immediately. */
export function applyTabIcon(logoUrl: string | null): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  link.href = logoUrl ?? DEFAULT_TAB_ICON;
}

/** Called by the settings page after a successful save or logo upload. */
export function setBrandName(name: string): void {
  publish({ name });
  document.title = name;
}

export function setBrandLogo(logoUrl: string | null): void {
  publish({ logoUrl });
  applyTabIcon(logoUrl);
}

/** Reads /api/brand once per page load, then keeps the snapshot shared. */
export function refreshBrand(): void {
  if (loaded) return;
  loaded = true;
  api
    .get<{ name: string; logoUrl: string | null }>("/api/brand")
    .then((res) => {
      publish({ name: res.name, logoUrl: res.logoUrl });
      applyTabIcon(res.logoUrl);
    })
    .catch(() => {
      loaded = false; // try again on the next mount
    });
}

export function useBrandIdentity(): BrandIdentity {
  const [identity, setIdentity] = useState(snapshot);

  useEffect(() => {
    listeners.add(setIdentity);
    refreshBrand();
    setIdentity(snapshot);
    return () => {
      listeners.delete(setIdentity);
    };
  }, []);

  useEffect(() => {
    document.title = identity.name;
  }, [identity.name]);

  return identity;
}

export function useBrand(): string {
  return useBrandIdentity().name;
}

export function useBrandLogo(): string | null {
  return useBrandIdentity().logoUrl;
}
