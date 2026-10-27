/**
 * Signal watchdog.
 *
 * A broadcast that is on air without a publisher is worse than a stopped one:
 * the panel says "In onda", the link keeps answering, and viewers wait on a
 * frozen player. This watcher closes the loop: when neither publish path has a
 * publisher for longer than the grace period, the broadcast is ended and its
 * segments are removed — the same state STOP would leave.
 *
 * The grace period exists because publishers blink: a Wi-Fi hiccup, an encoder
 * reconnect, a browser that renegotiates. Twenty seconds is long enough to ride
 * those out and short enough that nobody stares at a dead picture.
 */
import type { Db } from "../db.js";
import { audit } from "../db.js";
import { getActiveStream, setStreamStatus } from "../streams.js";
import type { PipelineApi } from "./pipeline.js";
import type { MediaMtxClient } from "./mediamtx.js";

export interface WatchdogDeps {
  db: Db;
  pipeline: PipelineApi;
  mediamtx: MediaMtxClient;
  primaryPath: string;
  backupPath: string;
  graceMs?: number;
  now?: () => number;
}

export class SignalWatchdog {
  private lastSeenAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly graceMs: number;

  constructor(private readonly deps: WatchdogDeps) {
    this.graceMs = deps.graceMs ?? 20_000;
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check. Exposed so tests drive it deterministically. */
  async tick(): Promise<void> {
    const { db, pipeline, mediamtx, primaryPath, backupPath } = this.deps;
    const now = this.deps.now?.() ?? Date.now();
    const active = getActiveStream(db);
    if (!active || !pipeline.isActive()) {
      this.lastSeenAt = null;
      return;
    }

    const [primary, backup] = await Promise.all([mediamtx.getPath(primaryPath), mediamtx.getPath(backupPath)]);
    if (primary === null && backup === null) {
      // The media server is unreachable: that is not the broadcaster's fault and
      // ending the broadcast would be a guess. Keep waiting.
      return;
    }

    const present = Boolean(primary?.ready) || Boolean(backup?.ready);
    if (present) {
      this.lastSeenAt = now;
      return;
    }

    this.lastSeenAt ??= now;
    if (now - this.lastSeenAt < this.graceMs) return;

    pipeline.stop();
    setStreamStatus(db, active.id, "ended");
    audit(db, { action: "stream_lost_signal", detail: active.slug });
    this.lastSeenAt = null;
  }
}
