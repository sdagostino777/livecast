/**
 * Generated event artwork.
 *
 * When an operator uploads no poster, the broadcast still needs a face: an SVG
 * with the event title over a gradient, picked deterministically from the slug
 * so two events do not look identical and the same event always looks the same.
 * SVG keeps this dependency-free and razor sharp at any size; it is served by
 * the API and cached briefly, because the title can be edited.
 */

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

/** Splits a title into at most two balanced lines for the 16:9 poster. */
function wrapTitle(title: string, maxChars = 22): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= maxChars) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
    if (lines.length === 2) break;
  }
  if (current && lines.length < 2) lines.push(current);
  if (lines.length === 0) lines.push(title);
  return lines.slice(0, 2);
}

export function posterSvg(opts: { title: string; brand: string; seed: string }): string {
  const palette = paletteFor(opts.seed);
  const lines = wrapTitle(opts.title);
  const fontSize = lines.some((line) => line.length > 16) ? 62 : 76;
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

/** Square variant for lists: initials over the same gradient. */
export function iconSvg(opts: { title: string; seed: string }): string {
  const palette = paletteFor(opts.seed);
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
