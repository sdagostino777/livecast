/**
 * Ingest addressing.
 *
 * The broadcaster pushes one RTMP stream into MediaMTX; FFmpeg reads it back
 * over loopback and encodes the HLS ladder. Two very different URLs come out of
 * this file: the public one (what goes into OBS, built from the operator-edited
 * settings) and the loopback one (what FFmpeg uses, with credentials the admin
 * never needs to see).
 */
import { config } from "./config.js";
import type { RuntimeSettings } from "./settings.js";

/** OBS "Server" field without credentials, e.g. rtmp://live.ndx-llc.com:1935/live */
export function ingestServer(settings: RuntimeSettings): string {
  return `rtmp://${settings.ingestHost}:${settings.ingestPort}/${config.ingestPath}`;
}

/** The full URL to paste into OBS, credentials included (admin-authenticated page only). */
export function ingestServerWithCreds(settings: RuntimeSettings): string | null {
  if (!config.publishPass) return null;
  return ingestServer(settings).replace(
    "rtmp://",
    `rtmp://${encodeURIComponent(config.publishUser)}:${encodeURIComponent(config.publishPass)}@`,
  );
}

/** What FFmpeg reads on loopback, e.g. rtmp://reader:pass@127.0.0.1:1935/live */
export function mediaInputUrl(): string {
  const url = new URL(config.mediamtxRtmpUrl);
  if (config.mediaReadUser) {
    url.username = config.mediaReadUser;
    url.password = config.mediaReadPass;
  }
  url.pathname = `/${config.ingestPath}`;
  return url.toString();
}
