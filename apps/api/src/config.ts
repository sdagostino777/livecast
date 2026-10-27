/**
 * Runtime configuration, read once from the environment.
 *
 * Everything the server needs to reach MediaMTX and to write HLS output lives
 * here, so a deployment changes behaviour through `.env` only — never code.
 * Defaults point at a local dev setup; production always sets them explicitly.
 */
import path from "node:path";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

const nodeEnv = str("NODE_ENV", "development");

export const config = {
  nodeEnv,
  /** Port the Fastify app listens on (nginx proxies to it in production). */
  port: num("PORT", 4100),
  host: str("HOST", "127.0.0.1"),

  /** All mutable state lives under one directory: SQLite DB, HLS files, recordings. */
  dataDir: path.resolve(str("DATA_DIR", "./data")),

  /** Public origin, used to build absolute URLs and to validate the Origin header. */
  publicUrl: str("PUBLIC_URL", "http://localhost:4100"),

  /** MediaMTX control API (localhost only — never exposed publicly). */
  mediamtxApiUrl: str("MEDIAMTX_API_URL", "http://127.0.0.1:9997"),
  /** RTMP address FFmpeg reads the ingested live stream from (localhost). */
  mediamtxRtmpUrl: str("MEDIAMTX_RTMP_URL", "rtmp://127.0.0.1:1935"),
  /** MediaMTX path the broadcaster publishes to. */
  ingestPath: str("INGEST_PATH", "live"),
  /** Second publish path, used as failover when the primary goes quiet. */
  ingestBackupPath: str("INGEST_BACKUP_PATH", "backup"),
  /** Credentials FFmpeg uses to read from MediaMTX (internal loopback only). */
  mediaReadUser: str("MEDIAMTX_READ_USER", ""),
  mediaReadPass: str("MEDIAMTX_READ_PASS", ""),

  /** The broadcaster's ingest credentials — shown in the admin panel. */
  publishUser: str("PUBLISH_USER", "publisher"),
  publishPass: str("PUBLISH_PASS", ""),

  /** Where the built React app lives (served by Fastify in production). */
  webRoot: path.resolve(str("WEB_ROOT", path.join(import.meta.dirname, "../../web/dist"))),

  ffmpegBin: str("FFMPEG_BIN", "ffmpeg"),

  /** HLS output: 2-second segments, six kept per variant (≈12 s window). */
  hlsSegmentSeconds: num("HLS_SEGMENT_SECONDS", 2),
  hlsListSize: num("HLS_LIST_SIZE", 6),

  sessionHours: num("SESSION_HOURS", 12),
  cookieSecure: bool("COOKIE_SECURE", nodeEnv === "production"),

  /** Seconds to wait for the broadcaster's RTMP connection before giving up. */
  ingestWaitSeconds: num("INGEST_WAIT_SECONDS", 600),
} as const;

export function hlsDir(slug: string): string {
  return path.join(config.dataDir, "hls", slug);
}

export function recordingsDir(): string {
  return path.join(config.dataDir, "recordings");
}

export function uploadsDir(): string {
  return path.join(config.dataDir, "uploads");
}

export function dbFile(): string {
  return path.join(config.dataDir, "database.sqlite");
}
