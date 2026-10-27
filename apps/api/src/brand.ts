/**
 * The install's own identity: the name and the logo this deployment runs under.
 *
 * Cloning the project must produce a service that looks like the operator's, not
 * like ours, so the name lives in settings and the logo is a file next to the
 * uploads. Nothing here knows about "Livecast".
 */
import fs from "node:fs";
import path from "node:path";

import { uploadsDir } from "./config.js";

const EXTENSIONS = ["png", "jpg", "webp"] as const;
export type LogoExtension = (typeof EXTENSIONS)[number];

const CONTENT_TYPES: Record<LogoExtension, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

function logoPath(ext: LogoExtension): string {
  return path.join(uploadsDir(), `brand-logo.${ext}`);
}

/** Extension of the stored logo, or null when the generated mark is used. */
export function brandLogoExtension(): LogoExtension | null {
  for (const ext of EXTENSIONS) {
    if (fs.existsSync(logoPath(ext))) return ext;
  }
  return null;
}

export function brandLogoFile(): { file: string; contentType: string } | null {
  const ext = brandLogoExtension();
  if (!ext) return null;
  return { file: logoPath(ext), contentType: CONTENT_TYPES[ext] };
}

export function saveBrandLogo(bytes: Buffer, ext: LogoExtension): void {
  fs.mkdirSync(uploadsDir(), { recursive: true });
  for (const other of EXTENSIONS) {
    if (other === ext) continue;
    try {
      fs.unlinkSync(logoPath(other));
    } catch {
      /* not present */
    }
  }
  fs.writeFileSync(logoPath(ext), bytes);
}

export function removeBrandLogo(): void {
  for (const ext of EXTENSIONS) {
    try {
      fs.unlinkSync(logoPath(ext));
    } catch {
      /* not present */
    }
  }
}
