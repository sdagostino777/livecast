/**
 * Minimal client for the MediaMTX control API.
 *
 * Used for one purpose: telling the admin panel whether the broadcaster's RTMP
 * connection has actually arrived. The HLS output the viewers watch is written
 * to disk by FFmpeg, not served by MediaMTX, so this API is advisory only —
 * if it is down, the page degrades to "ingest: unknown" and the stream keeps
 * working.
 */
export interface IngestState {
  ready: boolean;
  readers: number;
  source: string | null;
}

export class MediaMtxClient {
  constructor(
    private readonly apiUrl: string,
    private readonly timeoutMs = 2000,
  ) {}

  async getPath(name: string): Promise<IngestState | null> {
    try {
      const res = await fetch(`${this.apiUrl}/v3/paths/get/${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 404) return { ready: false, readers: 0, source: null };
      if (!res.ok) return null;
      const data = (await res.json()) as { ready?: boolean; readers?: unknown[]; source?: unknown };
      return {
        ready: data.ready === true,
        readers: Array.isArray(data.readers) ? data.readers.length : 0,
        source: data.source == null ? null : String(data.source),
      };
    } catch {
      return null;
    }
  }
}
