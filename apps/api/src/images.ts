/**
 * Just enough image inspection to describe an upload to a link crawler.
 *
 * Messaging apps reserve space from the declared og:image size, and a wrong
 * number distorts or crops the preview. Reading the real dimensions out of the
 * PNG/JPEG/WebP header is a few lines per format and no dependency.
 */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG: IHDR is the first chunk.
  if (buf.length > 24 && buf.toString("ascii", 1, 4) === "PNG") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // WebP: VP8X / VP8 / VP8L carry the size with different encodings.
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height };
    }
    if (chunk === "VP8 ") {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    return null;
  }

  // JPEG: walk the segments to the start-of-frame marker.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1] ?? 0;
      const length = buf.readUInt16BE(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }

  return null;
}

/**
 * Writes a 1280px-wide JPEG copy of a poster.
 *
 * The composed artwork (image + title) is an SVG that must carry the picture
 * inside it, and inlining the original upload would ship megabytes to every
 * viewer. FFmpeg is already here for the ladder, so it does the resize; if it
 * fails, the artwork falls back to inlining the original file.
 */
export function makePosterCopy(source: string, destination: string): void {
  void runFfmpeg(source, destination);
}

async function runFfmpeg(source: string, destination: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const bin = process.env.FFMPEG_BIN || "ffmpeg";
  execFile(
    bin,
    ["-y", "-loglevel", "error", "-i", source, "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", destination],
    { timeout: 20_000 },
    () => {
      /* best effort: the artwork has a fallback */
    },
  );
}
