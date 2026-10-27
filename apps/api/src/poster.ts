/**
 * Generated event artwork.
 *
 * When an operator uploads no poster, the broadcast still needs a face: an SVG
 * with the event title over a gradient, picked deterministically from the slug
 * so two events do not look identical and the same event always looks the same.
 * SVG keeps this dependency-free and razor sharp at any size; it is served by
 * the API and cached briefly, because the title can be edited.
 */

export const PALETTE_NAMES = ["blue", "teal", "indigo", "slate", "plum"] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];

const PALETTES = [
  { from: "#0f3559", to: "#2a6cb6", accent: "#7fb2e5" }, // deep navy → bright blue
  { from: "#0b3b4a", to: "#1d7a8c", accent: "#79d0dc" }, // petrol → teal
  { from: "#1e1a4d", to: "#4f46a5", accent: "#b3a9f0" }, // indigo → violet
  { from: "#12212e", to: "#3f6076", accent: "#9dc0d6" }, // slate → steel
  { from: "#3a1f3d", to: "#8d4a63", accent: "#e3a7b8" }, // plum → rose
] as const;

export function paletteIndex(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % PALETTES.length;
}

function paletteFor(seed: string): (typeof PALETTES)[number] {
  return PALETTES[paletteIndex(seed)] ?? PALETTES[0]!;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Wraps a title to a line width, without ever losing a word.
 *
 * The previous version stopped after two lines, which silently truncated long
 * event names ("Congresso Internazionale 2027 — Bologna" lost its city). Words
 * are the unit: a title that needs more room gets a smaller font instead.
 */
function wrapTitle(title: string, maxChars: number, maxLines = 3): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [title];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maxChars) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;

  // Only a title longer than the artwork can hold is clipped, and it says so.
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
  return kept;
}

/** Width the poster leaves for text, in its own coordinates. */
const TITLE_WIDTH = 1152; // 1280 minus 64px each side
/** Average advance of a bold sans glyph, plus a margin for wide ones. */
const CHAR_WIDTH = 0.56;

/**
 * Font size and lines for a title.
 *
 * One line is always preferred: an event name broken across two lines reads as
 * a layout accident. The type shrinks until the whole name fits, and only a name
 * too long for the artwork at a readable size is wrapped and, at the very end,
 * clipped with an ellipsis.
 */
function titleFit(title: string): { fontSize: number; lines: string[] } {
  const trimmed = title.trim();
  // Em dashes and capitals take more room than the average glyph.
  const effective = trimmed.length + (trimmed.match(/[—–]/g)?.length ?? 0) * 0.8;
  const single = Math.min(76, Math.floor(TITLE_WIDTH / (effective * CHAR_WIDTH)));
  if (single >= 46) return { fontSize: single, lines: [trimmed] };

  const wrapped = Math.max(44, single);
  const maxChars = Math.floor(TITLE_WIDTH / (wrapped * CHAR_WIDTH));
  return { fontSize: wrapped, lines: wrapTitle(trimmed, maxChars) };
}

export function posterSvg(opts: { title: string; brand: string; seed: string; palette?: string | null }): string {
  const palette = paletteByName(opts.palette) ?? paletteFor(opts.seed);
  const { fontSize, lines } = titleFit(opts.title);
  const lineHeight = fontSize * 1.18;
  const startY = 360 - ((lines.length - 1) * lineHeight) / 2;
  const text = lines
    .map(
      (line, index) =>
        `<text x="640" y="${Math.round(startY + index * lineHeight)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-label="${escapeXml(opts.title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.from}"/>
      <stop offset="100%" stop-color="${palette.to}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.15" r="0.75">
      <stop offset="0%" stop-color="${palette.accent}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${palette.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#bg)"/>
  <rect width="1280" height="720" fill="url(#glow)"/>
  <rect x="0" y="712" width="1280" height="8" fill="${palette.accent}" opacity="0.9"/>
  <text x="64" y="96" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="600" letter-spacing="3" fill="#ffffff" opacity="0.78">${escapeXml(opts.brand.toUpperCase())}</text>
  ${text}
  <text x="1216" y="664" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#ffffff" opacity="0.6">LIVE</text>
</svg>`;
}

/**
 * Title over an uploaded image.
 *
 * Compositing raster text would need an image library; an SVG that embeds the
 * uploaded file costs nothing, stays sharp at every size, and is a normal <img>
 * source for both the panel and the player.
 */
export function overlaySvg(opts: { imageHref: string; title: string; brand: string }): string {
  // `imageHref` is a data: URI on purpose: an SVG loaded through <img> cannot
  // fetch external subresources, so a linked /uploads/… path renders empty.
  const fit = titleFit(opts.title);
  const lines = fit.lines;
  const fontSize = Math.min(fit.fontSize, 62);
  const lineHeight = fontSize * 1.16;
  const firstY = 616 - ((lines.length - 1) * lineHeight);
  const text = lines
    .map(
      (line, index) =>
        `<text x="64" y="${Math.round(firstY + index * lineHeight)}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-label="${escapeXml(opts.title)}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="45%" stop-color="#04101d" stop-opacity="0"/>
      <stop offset="100%" stop-color="#04101d" stop-opacity="0.88"/>
    </linearGradient>
  </defs>
  <image x="0" y="0" width="1280" height="720" preserveAspectRatio="xMidYMid slice" href="${escapeXml(opts.imageHref)}" xlink:href="${escapeXml(opts.imageHref)}"/>
  <rect width="1280" height="720" fill="url(#scrim)"/>
  <text x="64" y="92" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="600" letter-spacing="3" fill="#ffffff" opacity="0.8">${escapeXml(opts.brand.toUpperCase())}</text>
  ${text}
</svg>`;
}

/** Square variant for lists: initials over the same gradient. */
/** The explicit choice wins; the slug-derived palette is the fallback. */
export function paletteByName(name?: string | null): (typeof PALETTES)[number] | null {
  if (!name) return null;
  const index = (PALETTE_NAMES as readonly string[]).indexOf(name);
  return index === -1 ? null : (PALETTES[index] ?? null);
}

export function iconSvg(opts: { title: string; seed: string; palette?: string | null }): string {
  const palette = paletteByName(opts.palette) ?? paletteFor(opts.seed);
  const initials = opts.title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="${escapeXml(opts.title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.from}"/>
      <stop offset="100%" stop-color="${palette.to}"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="64" fill="url(#bg)"/>
  <text x="256" y="316" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="208" font-weight="700" fill="#ffffff">${escapeXml(initials)}</text>
</svg>`;
}
