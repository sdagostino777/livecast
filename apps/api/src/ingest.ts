/**
 * Ingest addressing.
 *
 * The broadcaster pushes one RTMP stream into MediaMTX; FFmpeg reads it back
 * over loopback and encodes the HLS ladder. Two very different URLs come out of
 * this file: the public one (what an external encoder gets, built from the operator-edited
 * settings) and the loopback one (what FFmpeg uses, with credentials the admin
 * never needs to see).
 *
 * Credentials travel as `?user=&pass=` query parameters, not as `user:pass@` in
 * the authority: MediaMTX strips the userinfo when parsing an RTMP URL, so the
 * userinfo form authenticates as anonymous and is rejected. This was verified
 * against MediaMTX 1.21 (see docs/RUNBOOK.md).
 */
import { config } from "./config.js";
import type { RuntimeSettings } from "./settings.js";

function withQuery(base: string, user: string, pass: string): string {
  const url = new URL(base);
  url.searchParams.set("user", user);
  url.searchParams.set("pass", pass);
  return url.toString();
}

/** The encoder "Server" value without credentials, e.g. rtmp://live.example.com:1935/live */
export function ingestServer(settings: RuntimeSettings, path: string = config.ingestPath): string {
  return `rtmp://${settings.ingestHost}:${settings.ingestPort}/${path}`;
}

/** The full URL to paste into an external encoder (admin-authenticated page only). Stream key stays empty. */
export function ingestServerWithCreds(settings: RuntimeSettings, path: string = config.ingestPath): string | null {
  if (!config.publishPass) return null;
  return withQuery(ingestServer(settings, path), config.publishUser, config.publishPass);
}

/** What FFmpeg reads on loopback via RTMP, e.g. rtmp://127.0.0.1:1935/live?user=… */
export function mediaInputUrl(path: string = config.ingestPath): string {
  const base = config.mediamtxRtmpUrl.replace(/\/+$/, "") + `/${path}`;
  if (!config.mediaReadUser) return base;
  return withQuery(base, config.mediaReadUser, config.mediaReadPass);
}

/**
 * The same stream read over RTSP. MediaMTX republishes every path on RTSP
 * regardless of how it was published, so this is the encoder's first choice:
 * RTMP readers reject WebRTC-published streams with an I/O error.
 */
export function mediaRtspInputUrl(path: string = config.ingestPath): string {
  const url = new URL(config.mediamtxRtspUrl.replace(/\/+$/, "") + `/${path}`);
  if (config.mediaReadUser) {
    url.username = config.mediaReadUser;
    url.password = config.mediaReadPass;
  }
  return url.toString();
}
