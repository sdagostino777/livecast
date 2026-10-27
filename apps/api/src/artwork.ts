/**
 * One place that answers "what does the audience see for this event?".
 *
 * The poster URL is public and identical for the panel and the player: an
 * uploaded image (with or without the title drawn on top) or the generated
 * template when no image exists. Two routes serve it — the admin one is
 * `no-store` so the panel preview follows edits, the public one is cacheable.
 */
import fs from "node:fs";
import path from "node:path";

import { uploadsDir } from "./config.js";
import { overlaySvg, posterSvg } from "./poster.js";
import type { StreamRow } from "./streams.js";

export type Artwork =
  | { kind: "svg"; body: string }
  | { kind: "file"; file: string; contentType: string };

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function posterFile(row: StreamRow): string | null {
  if (!row.poster_ext) return null;
  const file = path.join(uploadsDir(), `${row.slug}.poster.${row.poster_ext}`);
  return fs.existsSync(file) ? file : null;
}

export function artworkFor(row: StreamRow, brand: string): Artwork {
  const generated = posterSvg({
    title: row.title,
    brand,
    seed: row.slug,
    palette: row.poster_palette,
  });
  const file = posterFile(row);
  // A missing file (deleted by hand) falls back to the template instead of a
  // broken image in front of the audience.
  if (!file) return { kind: "svg", body: generated };
  if (!row.poster_overlay) {
    return { kind: "file", file, contentType: CONTENT_TYPES[row.poster_ext!] ?? "application/octet-stream" };
  }
  return {
    kind: "svg",
    body: overlaySvg({
      imageHref: `/uploads/${row.slug}.poster.${row.poster_ext}`,
      title: row.title,
      brand,
    }),
  };
}
