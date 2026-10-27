/**
 * Runtime settings — the handful of things an operator can change from the
 * admin panel without a redeploy.
 *
 * Why they live in the database and not only in `.env`: the same install must
 * be able to point at a CDN (a URL the VPS never had configured at install
 * time), or move behind a new domain, from the browser. Env remains the seed:
 * on first boot the store copies the defaults into the table, and after that the
 * table wins. Every value is validated before it is stored, because these
 * strings end up in redirects and player URLs.
 */
import { z } from "zod";
import type { Db } from "./db.js";
import { config } from "./config.js";

export interface RuntimeSettings {
  /** Name shown in the panel, the player and the page title. */
  brandName: string;
  /** Canonical public origin of this install, e.g. https://live.example.com */
  publicBaseUrl: string;
  /** Optional CDN origin (Bunny/Cloudflare/Fastly). Empty = serve HLS from the VPS. */
  cdnBaseUrl: string;
  /** Host the encoder points at. Usually the same as publicBaseUrl's host. */
  ingestHost: string;
  /** RTMP port the encoder points at. */
  ingestPort: number;
}

const SETTING_KEYS = ["brandName", "publicBaseUrl", "cdnBaseUrl", "ingestHost", "ingestPort"] as const;

const URL_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i;

export const SettingsPatch = z.object({
  brandName: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((v) => /^[\p{L}\p{N} .\-&']+$/u.test(v), "invalid_name")
    .optional(),
  publicBaseUrl: z.string().trim().max(200).refine((v) => URL_RE.test(v.replace(/\/+$/, "")), "invalid_url").optional(),
  cdnBaseUrl: z
    .union([z.literal(""), z.string().trim().max(200).refine((v) => URL_RE.test(v.replace(/\/+$/, "")), "invalid_url")])
    .optional(),
  ingestHost: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((v) => /^[a-z0-9.-]+$/i.test(v), "invalid_host")
    .optional(),
  ingestPort: z.number().int().min(1).max(65535).optional(),
});

export type SettingsPatchInput = z.infer<typeof SettingsPatch>;

function trimBase(value: string): string {
  return value.replace(/\/+$/, "");
}

export function defaultSettings(): RuntimeSettings {
  const url = new URL(config.publicUrl);
  return {
    brandName: process.env.BRAND_NAME || "Livecast",
    publicBaseUrl: trimBase(config.publicUrl),
    cdnBaseUrl: "",
    ingestHost: process.env.INGEST_HOST || url.hostname,
    ingestPort: Number(process.env.INGEST_PORT || 1935),
  };
}

export class SettingsStore {
  private current: RuntimeSettings;

  constructor(private readonly db: Db) {
    this.current = this.load();
  }

  get(): RuntimeSettings {
    return this.current;
  }

  /** Validates, persists, and applies a partial update. Throws on invalid input. */
  update(patch: SettingsPatchInput): RuntimeSettings {
    const parsed = SettingsPatch.parse(patch);
    const next: RuntimeSettings = { ...this.current };

    if (parsed.brandName !== undefined) next.brandName = parsed.brandName;
    if (parsed.publicBaseUrl !== undefined) next.publicBaseUrl = trimBase(parsed.publicBaseUrl);
    if (parsed.cdnBaseUrl !== undefined) next.cdnBaseUrl = parsed.cdnBaseUrl === "" ? "" : trimBase(parsed.cdnBaseUrl);
    if (parsed.ingestHost !== undefined) next.ingestHost = parsed.ingestHost.toLowerCase();
    if (parsed.ingestPort !== undefined) next.ingestPort = parsed.ingestPort;

    if (next.cdnBaseUrl !== "" && new URL(next.cdnBaseUrl).origin === new URL(next.publicBaseUrl).origin) {
      throw new Error("cdn_same_as_origin");
    }

    const upsert = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const tx = this.db.transaction(() => {
      upsert.run("brandName", next.brandName);
      upsert.run("publicBaseUrl", next.publicBaseUrl);
      upsert.run("cdnBaseUrl", next.cdnBaseUrl);
      upsert.run("ingestHost", next.ingestHost);
      upsert.run("ingestPort", String(next.ingestPort));
    });
    tx();
    this.current = next;
    return next;
  }

  /** Where viewers should load HLS from: the CDN when configured, else the origin. */
  hlsBaseUrl(): string {
    return this.current.cdnBaseUrl || this.current.publicBaseUrl;
  }

  private load(): RuntimeSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const defaults = defaultSettings();
    const pick = (key: (typeof SETTING_KEYS)[number], fallback: string): string => stored.get(key) ?? fallback;

    const loaded: RuntimeSettings = {
      brandName: pick("brandName", defaults.brandName),
      publicBaseUrl: trimBase(pick("publicBaseUrl", defaults.publicBaseUrl)),
      cdnBaseUrl: trimBase(pick("cdnBaseUrl", defaults.cdnBaseUrl)),
      ingestHost: pick("ingestHost", defaults.ingestHost),
      ingestPort: Number(pick("ingestPort", String(defaults.ingestPort))) || defaults.ingestPort,
    };

    // Seed once, so the values are visible and editable in the panel from the
    // very first visit instead of appearing only after the first save.
    if (rows.length === 0) {
      this.current = defaults;
      const upsert = this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      const tx = this.db.transaction(() => {
        upsert.run("brandName", defaults.brandName);
        upsert.run("publicBaseUrl", defaults.publicBaseUrl);
        upsert.run("cdnBaseUrl", defaults.cdnBaseUrl);
        upsert.run("ingestHost", defaults.ingestHost);
        upsert.run("ingestPort", String(defaults.ingestPort));
      });
      tx();
    }
    return loaded;
  }
}
