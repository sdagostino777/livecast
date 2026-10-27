/**
 * The HLS encoder pipeline.
 *
 * One FFmpeg process per live stream: it reads the single RTMP publisher from
 * MediaMTX (loopback only) and writes an adaptive-bitrate HLS ladder to disk,
 * where nginx serves it directly. Keeping the encoder out of the media server
 * is what makes the output a plain directory of files — the easiest possible
 * thing to put behind a CDN later, and trivially inspectable while debugging.
 *
 * The ladder is fixed at 720p/480p/360p. The source frame is inspected first:
 * a 1080p source is downscaled to 720p rather than published as-is, because the
 * bandwidth that matters on mobile networks is the top rung, and a third bitrate
 * tier on a 4‑vCPU box is CPU we do not have to waste.
 *
 * Failure behaviour: encoders reconnect, laptops sleep, Wi-Fi drops. FFmpeg exits
 * when its RTMP input closes, so the supervisor relaunches it with a short
 * backoff until the admin stops the stream or the ingest timeout fires.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface LadderRung {
  name: string;
  height: number;
  videoBitrateKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  audioBitrateKbps: number;
}

export const DEFAULT_LADDER: readonly LadderRung[] = [
  { name: "720", height: 720, videoBitrateKbps: 2800, maxrateKbps: 3200, bufsizeKbps: 5600, audioBitrateKbps: 128 },
  { name: "480", height: 480, videoBitrateKbps: 1400, maxrateKbps: 1600, bufsizeKbps: 2800, audioBitrateKbps: 96 },
  { name: "360", height: 360, videoBitrateKbps: 800, maxrateKbps: 1000, bufsizeKbps: 1600, audioBitrateKbps: 64 },
];

export type StreamKind = "video" | "audio";

export interface PipelineArgsOptions {
  ffmpegBin: string;
  inputUrl: string;
  outDir: string;
  kind: StreamKind;
  /** Whether the source carries audio; WebRTC publishers may be video-only. */
  hasAudio?: boolean;
  segmentSeconds: number;
  listSize: number;
  recordFile: string | null;
  ladder?: readonly LadderRung[];
}

/**
 * Builds the FFmpeg argument list. Pure on purpose: the exact flags are the
 * part of this system most likely to be wrong after an FFmpeg upgrade, so they
 * are asserted in tests and exercised by a smoke script rather than eyeballed.
 */
/**
 * Audio-only broadcasts are a first-class mode, not a muted video: one AAC
 * rendition, no video pipeline at all (`-vn`). That matters on the publisher
 * side too — a publisher may still send video, and this drops it without paying for a
 * scale + x264 ladder.
 */

/**
 * Input-specific flags. RTSP is read over TCP (UDP loses packets on a VPS and
 * makes the read stall) and with a timeout, so a dead source fails fast instead
 * of parking the broadcast on "Preparazione…".
 */
function inputFlags(inputUrl: string): string[] {
  if (inputUrl.startsWith("rtsp://")) {
    // RTSP demuxer option names differ from the generic ones: `-timeout`
    // (microseconds, socket I/O) exists, `-rw_timeout` does not — using the
    // wrong name makes FFmpeg exit immediately with "Option not found".
    return ["-rtsp_transport", "tcp", "-timeout", "15000000"];
  }
  return [];
}

export function buildFfmpegAudioArgs(opts: PipelineArgsOptions): string[] {
  const args: string[] = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "warning",
    "-fflags",
    "+genpts",
    ...inputFlags(opts.inputUrl),
    "-i",
    opts.inputUrl,
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-f",
    "hls",
    "-hls_time",
    String(opts.segmentSeconds),
    "-hls_list_size",
    String(opts.listSize),
    "-hls_flags",
    "delete_segments+independent_segments+program_date_time",
    "-hls_segment_filename",
    path.join(opts.outDir, "audio", "seg_%06d.ts"),
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    "a:0,name:audio",
    path.join(opts.outDir, "%v", "index.m3u8"),
  ];

  if (opts.recordFile) {
    args.push(
      "-map",
      "0:a:0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "mp4",
      opts.recordFile,
    );
  }
  return args;
}

export function buildFfmpegArgs(opts: PipelineArgsOptions): string[] {
  if (opts.kind === "audio") return buildFfmpegAudioArgs(opts);

  const ladder = opts.ladder ?? DEFAULT_LADDER;
  const hasAudio = opts.hasAudio !== false;
  const record = Boolean(opts.recordFile);
  // One extra branch of the split when recording: FFmpeg refuses to reuse a
  // filter output in an second output file, so the recording needs its own label.
  const streams = ladder.length + (record ? 1 : 0);
  const splits = Array.from({ length: streams }, (_, i) => `[v${i}]`).join("");
  const scales = ladder.map((r, i) => `[v${i}]scale=-2:${r.height}[vout${i}]`);
  if (record) scales.push(`[v${streams - 1}]scale=-2:720[vrec]`);
  const filter = `[0:v]split=${streams}${splits};${scales.join(";")}`;

  const args: string[] = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "warning",
    // Repeat timestamps so a publisher that restarts does not poison the HLS timelines.
    "-fflags",
    "+genpts",
    ...inputFlags(opts.inputUrl),
    "-i",
    opts.inputUrl,
    "-filter_complex",
    filter,
  ];

  for (let i = 0; i < ladder.length; i++) {
    args.push("-map", `[vout${i}]`);
    if (hasAudio) args.push("-map", "0:a:0");
  }

  for (let i = 0; i < ladder.length; i++) {
    const r = ladder[i]!;
    args.push(
      `-c:v:${i}`, "libx264",
      `-preset:v:${i}`, "veryfast",
      `-profile:v:${i}`, "main",
      `-b:v:${i}`, `${r.videoBitrateKbps}k`,
      `-maxrate:v:${i}`, `${r.maxrateKbps}k`,
      `-bufsize:v:${i}`, `${r.bufsizeKbps}k`,
    );
    if (hasAudio) {
      args.push(
        `-c:a:${i}`, "aac",
        `-b:a:${i}`, `${r.audioBitrateKbps}k`,
        `-ac:a:${i}`, "2",
        `-ar:a:${i}`, "48000",
      );
    }
  }

  args.push(
    "-pix_fmt", "yuv420p",
    "-g", "96",
    "-keyint_min", "96",
    "-sc_threshold", "0",
    // Force a keyframe at every segment boundary regardless of input frame rate:
    // segments must start on a keyframe or playback randomly fails to seek in.
    "-force_key_frames", `expr:gte(t,n_forced*${opts.segmentSeconds})`,
    "-f", "hls",
    "-hls_time", String(opts.segmentSeconds),
    "-hls_list_size", String(opts.listSize),
    "-hls_flags", "delete_segments+independent_segments+program_date_time",
    "-hls_segment_filename", path.join(opts.outDir, "%v", "seg_%06d.ts"),
    "-master_pl_name", "master.m3u8",
    "-var_stream_map",
    ladder.map((r, i) => (hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`)).join(" "),
  );

  // The HLS output must be the first output file, and everything from `-f hls`
  // to this path belongs to it. The recording comes after: an output option
  // group is terminated by its filename, so interleaving the two breaks the
  // HLS muxer's options in a way FFmpeg reports only as confusing warnings.
  args.push(path.join(opts.outDir, "%v", "index.m3u8"));

  if (opts.recordFile) {
    args.push("-map", "[vrec]");
    if (hasAudio) args.push("-map", "0:a:0");
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-b:v",
      "2000k",
      "-f",
      "mp4",
      "-movflags",
      "+frag_keyframe+empty_moov+default_base_moof",
      opts.recordFile,
    );
  }

  return args;
}

export type PipelineState = "idle" | "starting" | "live" | "ended";

export interface PipelineCallbacks {
  onLive: () => void;
  onEnded: (reason: "stopped" | "ingest_timeout" | "fatal") => void;
  onLog?: (line: string) => void;
}

/**
 * The surface the routes use. Declared as an interface so tests (and any future
 * second encoder backend) can satisfy it without constructing a real process.
 */
export interface PipelineApi {
  readonly status: PipelineState;
  readonly lastExit: { code: number | null; signal: string | null; stderrTail: string } | null;
  isActive(): boolean;
  startedAt(): number | null;
  attempts(): number;
  /** Which publisher the encoder is reading: the primary, or the failover path. */
  currentInput(): "primary" | "backup" | null;
  /** Elementary streams the source actually carries (ffprobe). */
  caps(): { video: boolean; audio: boolean } | null;
  start(opts: PipelineStartOptions, callbacks: PipelineCallbacks): void;
  stop(): void;
}

export interface PipelineStartOptions extends Omit<PipelineArgsOptions, "inputUrl" | "outDir"> {
  outDir: string;
  /** Primary and optional failover publish paths (RTSP preferred). */
  inputUrls: {
    primary: string;
    backup: string | null;
    /** Tried after repeated open failures, e.g. RTMP when RTSP cannot read. */
    fallbackPrimary?: string | null;
    fallbackBackup?: string | null;
  };
  /** Asked before every launch; the first path that answers true is used. */
  probeReady?: (which: "primary" | "backup") => Promise<boolean>;
  /** Inspects the source once; WebRTC publishers can be video-only (Opus audio
   *  does not survive the RTMP hop), so the encoder must not demand audio. */
  probeInput?: (
    url: string,
  ) => Promise<{ video: boolean; audio: boolean } | null> | { video: boolean; audio: boolean } | null;
  /** Give up (and end the stream) if nothing is published within this window. */
  ingestWaitSeconds: number;
  recordFile: string | null;
}

interface PipelineMeta {
  startedAt: number;
  attempts: number;
  ffmpeg: ChildProcess | null;
  currentInput: "primary" | "backup";
  stopping: boolean;
  monitorTimer: NodeJS.Timeout | null;
  retryTimer: NodeJS.Timeout | null;
  ingestTimer: NodeJS.Timeout | null;
  lastSegments: Set<string>;
  caps: { video: boolean; audio: boolean } | null;
  stallTicks: number;
  callbacks: PipelineCallbacks;
  opts: PipelineStartOptions;
}

const RETRY_DELAY_MS = 2500;
const MONITOR_INTERVAL_MS = 2000;
// Two minutes of an unchanged segment list while "live" means FFmpeg is
// producing nothing: the encoder is hung, or the publisher died in a way that
// left the RTMP socket open. Ten minutes would be too late for an event.
const STALL_TICKS = 60;
const MAX_RETRY_ATTEMPTS = 200; // generous: a 10-minute ingest window may take many 2.5 s retries

/** Asks ffprobe which elementary streams exist. Null when it cannot tell. */
export function probeMedia(ffmpegBin: string, url: string, timeoutMs = 8000): Promise<{ video: boolean; audio: boolean } | null> {
  const ffprobe = ffmpegBin.replace(/ffmpeg([^/\\]*)$/, "ffprobe$1");
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(
      ffprobe,
      ["-v", "error", ...inputFlags(url), "-show_entries", "stream=codec_type", "-of", "csv=p=0", url],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let out = "";
    const finish = (value: { video: boolean; audio: boolean } | null) => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      const types = out.split(/\r?\n/).map((line) => line.trim().toLowerCase());
      finish({ video: types.includes("video"), audio: types.includes("audio") });
    });
  });
}

export class HlsPipeline implements PipelineApi {
  private state: PipelineState = "idle";
  private meta: PipelineMeta | null = null;

  constructor(
    private readonly spawnFn: typeof spawn = spawn,
    private readonly now: () => number = Date.now,
  ) {}

  get status(): PipelineState {
    return this.state;
  }

  isActive(): boolean {
    return this.state === "starting" || this.state === "live";
  }

  startedAt(): number | null {
    return this.meta?.startedAt ?? null;
  }

  attempts(): number {
    return this.meta?.attempts ?? 0;
  }

  /**
   * Starts the pipeline. The stream is "starting" until the first HLS segment
   * exists on disk, then "live". If no publisher ever shows up within
   * `ingestWaitSeconds` the pipeline stops itself with reason "ingest_timeout".
   */
  start(opts: PipelineStartOptions, callbacks: PipelineCallbacks): void {
    if (this.isActive()) throw new Error("pipeline already running");

    // Whatever a previous run left behind is not this broadcast: switching kind
    // (video ↔ audio) reuses the same link and the same directory, so a stale
    // master.m3u8 pointing at the old ladder would be served to viewers while
    // the new encoder is still starting.
    fs.rmSync(opts.outDir, { recursive: true, force: true });
    const rungs = opts.kind === "audio" ? ["audio"] : ["720", "480", "360"];
    for (const rung of rungs) fs.mkdirSync(path.join(opts.outDir, rung), { recursive: true });
    if (opts.recordFile) fs.mkdirSync(path.dirname(opts.recordFile), { recursive: true });

    this.state = "starting";
    this.meta = {
      startedAt: this.now(),
      attempts: 0,
      ffmpeg: null,
      currentInput: "primary",
      stopping: false,
      monitorTimer: null,
      retryTimer: null,
      ingestTimer: null,
      lastSegments: new Set(),
      caps: null,
      stallTicks: 0,
      callbacks,
      opts,
    };

    const meta = this.meta;
    meta.ingestTimer = setTimeout(() => {
      if (this.state === "starting") this.finish("ingest_timeout");
    }, opts.ingestWaitSeconds * 1000);

    void this.launch();
  }

  stop(): void {
    if (!this.isActive()) return;
    this.finish("stopped");
  }

  private async launch(): Promise<void> {
    const meta = this.meta;
    if (!meta || meta.stopping) return;

    // Failover: ask which publisher is actually connected right now. The primary
    // always wins when both are; the backup exists so the primary's death is a
    // two-second relaunch, not a black screen.
    let which: "primary" | "backup" = "primary";
    if (meta.opts.probeReady) {
      try {
        if (!(await meta.opts.probeReady("primary")) && meta.opts.inputUrls.backup) {
          which = "backup";
        }
      } catch {
        which = "primary";
      }
    }
    meta.currentInput = which;
    // Alternate protocols instead of switching for good: a WebRTC publisher is
    // readable over RTSP but not over RTMP, so committing to the fallback after
    // two failures would abandon the only working path. Odd attempts from the
    // third onwards try the fallback, everything else tries the primary.
    const useFallback = meta.attempts >= 3 && meta.attempts % 2 === 1;
    const protocolUrl =
      which === "backup"
        ? useFallback && meta.opts.inputUrls.fallbackBackup
          ? meta.opts.inputUrls.fallbackBackup
          : (meta.opts.inputUrls.backup ?? meta.opts.inputUrls.primary)
        : useFallback && meta.opts.inputUrls.fallbackPrimary
          ? meta.opts.inputUrls.fallbackPrimary
          : meta.opts.inputUrls.primary;
    const inputUrl = protocolUrl;
    this.lastInputUrl = inputUrl.replace(/:[^:@/]+@/, ":****@");

    if (!meta.caps) {
      const probe = meta.opts.probeInput ?? ((url: string) => probeMedia(meta.opts.ffmpegBin, url));
      try {
        const result = probe(inputUrl);
        // A synchronous probe (tests, stubs) keeps launch synchronous; a real
        // ffprobe returns a promise and is awaited before the encoder spawns.
        meta.caps = result instanceof Promise ? await result : result;
      } catch {
        meta.caps = null;
      }
      if (meta.caps) {
        meta.callbacks.onLog?.(`source streams: video=${meta.caps.video} audio=${meta.caps.audio}`);
      }
    }

    // An audio-only source (or a WebRTC publisher whose audio cannot cross the
    // RTMP hop) must not be fed to the video ladder: it would fail on 0:a:0 and
    // the broadcast would sit on "Preparazione…" forever.
    const sourceAudioOnly = meta.caps !== null && !meta.caps.video && meta.caps.audio;

    meta.attempts += 1;
    const args = sourceAudioOnly
      ? buildFfmpegAudioArgs({
          ffmpegBin: meta.opts.ffmpegBin,
          inputUrl,
          outDir: meta.opts.outDir,
          kind: "audio",
          segmentSeconds: meta.opts.segmentSeconds,
          listSize: meta.opts.listSize,
          recordFile: meta.opts.recordFile,
        })
      : buildFfmpegArgs({
          ffmpegBin: meta.opts.ffmpegBin,
          inputUrl,
          outDir: meta.opts.outDir,
          kind: meta.opts.kind,
          hasAudio: meta.caps ? meta.caps.audio : true,
          segmentSeconds: meta.opts.segmentSeconds,
          listSize: meta.opts.listSize,
          recordFile: meta.opts.recordFile,
          ladder: meta.opts.ladder,
        });

    const child = this.spawnFn(meta.opts.ffmpegBin, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    meta.ffmpeg = child;

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      meta.callbacks.onLog?.(text.trim());
    });

    child.on("error", (err: Error) => {
      meta.callbacks.onLog?.(`ffmpeg spawn error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      meta.ffmpeg = null;
      if (meta.stopping || this.meta !== meta) {
        return;
      }
      meta.callbacks.onLog?.(`ffmpeg exited (code=${code ?? "?"}, signal=${signal ?? "?"})`);
      if (meta.attempts >= MAX_RETRY_ATTEMPTS) {
        this.finish("fatal");
        return;
      }
      meta.retryTimer = setTimeout(() => {
        meta.retryTimer = null;
        void this.launch();
      }, RETRY_DELAY_MS);
      // Keep a hint of the last error for diagnostics on the next overview call.
      this.lastExit = { code, signal, stderrTail };
    });

    meta.stallTicks = 0;
    if (!meta.monitorTimer) {
      meta.monitorTimer = setInterval(() => this.monitor(), MONITOR_INTERVAL_MS);
    }
  }

  lastExit: { code: number | null; signal: string | null; stderrTail: string } | null = null;

  /** Last input actually attempted, credentials masked — for the panel's diagnostics. */
  lastInputUrl: string | null = null;

  /** Segment names currently on disk, across all rungs: "720/seg_000012.ts" etc. */
  private listSegments(outDir: string, kind: StreamKind): Set<string> {
    const names = new Set<string>();
    const rungs = kind === "audio" ? ["audio"] : ["720", "480", "360"];
    for (const rung of rungs) {
      try {
        for (const file of fs.readdirSync(path.join(outDir, rung))) {
          if (file.endsWith(".ts")) names.add(`${rung}/${file}`);
        }
      } catch {
        /* variant directory not created yet */
      }
    }
    return names;
  }

  /**
   * The single watchdog loop. It does two jobs, which is what makes it small:
   * detect the first segment (starting → live), and detect a stalled encoder
   * while live (unchanged segment list for STALL_TICKS ticks → kill it, so the
   * exit handler relaunches). Counting ticks instead of comparing wall-clock
   * time keeps it deterministic under fake timers in tests.
   */
  private monitor(): void {
    const meta = this.meta;
    if (!meta) return;

    const segments = this.listSegments(meta.opts.outDir, meta.opts.kind);

    if (this.state === "starting") {
      if (segments.size === 0) return;
      this.state = "live";
      if (meta.ingestTimer) clearTimeout(meta.ingestTimer);
      meta.ingestTimer = null;
      meta.lastSegments = segments;
      meta.stallTicks = 0;
      meta.callbacks.onLive();
      return;
    }

    if (this.state !== "live") return;

    const grew = [...segments].some((name) => !meta.lastSegments.has(name));
    if (grew) {
      meta.lastSegments = segments;
      meta.stallTicks = 0;
      return;
    }

    meta.stallTicks += 1;
    if (meta.stallTicks >= STALL_TICKS && meta.ffmpeg) {
      meta.stallTicks = 0;
      meta.callbacks.onLog?.(
        `watchdog: no new HLS segments for ${(STALL_TICKS * MONITOR_INTERVAL_MS) / 1000}s — restarting the encoder`,
      );
      // SIGKILL, not SIGINT: a hung encoder ignores the polite signal.
      meta.ffmpeg.kill("SIGKILL");
    }
  }

  currentInput(): "primary" | "backup" | null {
    return this.meta?.currentInput ?? null;
  }

  caps(): { video: boolean; audio: boolean } | null {
    return this.meta?.caps ?? null;
  }

  private finish(reason: "stopped" | "ingest_timeout" | "fatal"): void {
    const meta = this.meta;
    if (!meta || meta.stopping) return;
    // Record the reason before any exit handler can run: the FFmpeg exit handler
    // calls finishEnded() synchronously for an already-dead child.
    this.endedReason = reason;
    meta.stopping = true;
    if (meta.monitorTimer) clearInterval(meta.monitorTimer);
    if (meta.retryTimer) clearTimeout(meta.retryTimer);
    if (meta.ingestTimer) clearTimeout(meta.ingestTimer);
    meta.monitorTimer = meta.retryTimer = meta.ingestTimer = null;

    // STOP is immediate from the panel's point of view: the state flips here,
    // the directory is removed here, and the callback fires here. Waiting for
    // FFmpeg to acknowledge a signal left the panel showing "In onda" while the
    // link was already offline.
    this.state = "ended";
    const child = meta.ffmpeg;
    if (child) {
      try {
        child.kill("SIGINT");
      } catch {
        /* already gone */
      }
      const force = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 4000);
      force.unref?.();
    }
    try {
      fs.rmSync(meta.opts.outDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    const finishedMeta = meta;
    this.meta = null;
    finishedMeta.callbacks.onEnded(reason);
    // If FFmpeg has already exited, the exit handler called finishEnded. If it is
    // alive, it will exit shortly and call it there. Guard against a crash-loop
    // with no child: end immediately.
    if (!child) this.finishEnded();
    this.endedReason = reason;
  }

  private endedReason: "stopped" | "ingest_timeout" | "fatal" = "stopped";

  private finishEnded(): void {
    const meta = this.meta;
    if (!meta) return;
    const reason = this.endedReason;
    this.state = "ended";
    this.meta = null;
    // Remove generated media: a stream replay is delivered from recordings, not
    // from stale HLS segments, and a stale segment is a bug waiting to ship.
    try {
      fs.rmSync(meta.opts.outDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    meta.callbacks.onEnded(reason);
  }
}
