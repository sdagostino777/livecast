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
 * Failure behaviour: OBS reconnects, laptops sleep, Wi-Fi drops. FFmpeg exits
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

export interface PipelineArgsOptions {
  ffmpegBin: string;
  inputUrl: string;
  outDir: string;
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
export function buildFfmpegArgs(opts: PipelineArgsOptions): string[] {
  const ladder = opts.ladder ?? DEFAULT_LADDER;
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
    "-i",
    opts.inputUrl,
    "-filter_complex",
    filter,
  ];

  for (let i = 0; i < ladder.length; i++) {
    args.push("-map", `[vout${i}]`);
    args.push("-map", "0:a:0");
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
      `-c:a:${i}`, "aac",
      `-b:a:${i}`, `${r.audioBitrateKbps}k`,
      `-ac:a:${i}`, "2",
      `-ar:a:${i}`, "48000",
    );
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
    "-var_stream_map", ladder.map((r, i) => `v:${i},a:${i},name:${r.name}`).join(" "),
  );

  // The HLS output must be the first output file, and everything from `-f hls`
  // to this path belongs to it. The recording comes after: an output option
  // group is terminated by its filename, so interleaving the two breaks the
  // HLS muxer's options in a way FFmpeg reports only as confusing warnings.
  args.push(path.join(opts.outDir, "%v", "index.m3u8"));

  if (opts.recordFile) {
    args.push(
      "-map", "[vrec]",
      "-map", "0:a:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-b:v", "2000k",
      "-c:a", "aac",
      "-b:a", "128k",
      "-f", "mp4",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
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
  start(opts: PipelineStartOptions, callbacks: PipelineCallbacks): void;
  stop(): void;
}

export interface PipelineStartOptions extends Omit<PipelineArgsOptions, "outDir"> {
  outDir: string;
  /** Give up (and end the stream) if nothing is published within this window. */
  ingestWaitSeconds: number;
  recordFile: string | null;
}

interface PipelineMeta {
  startedAt: number;
  attempts: number;
  ffmpeg: ChildProcess | null;
  stopping: boolean;
  monitorTimer: NodeJS.Timeout | null;
  retryTimer: NodeJS.Timeout | null;
  ingestTimer: NodeJS.Timeout | null;
  lastSegments: Set<string>;
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

    fs.mkdirSync(path.join(opts.outDir, "720"), { recursive: true });
    fs.mkdirSync(path.join(opts.outDir, "480"), { recursive: true });
    fs.mkdirSync(path.join(opts.outDir, "360"), { recursive: true });
    if (opts.recordFile) fs.mkdirSync(path.dirname(opts.recordFile), { recursive: true });

    this.state = "starting";
    this.meta = {
      startedAt: this.now(),
      attempts: 0,
      ffmpeg: null,
      stopping: false,
      monitorTimer: null,
      retryTimer: null,
      ingestTimer: null,
      lastSegments: new Set(),
      stallTicks: 0,
      callbacks,
      opts,
    };

    this.meta.ingestTimer = setTimeout(() => {
      if (this.state === "starting") this.finish("ingest_timeout");
    }, opts.ingestWaitSeconds * 1000);

    this.launch();
  }

  stop(): void {
    if (!this.isActive()) return;
    this.finish("stopped");
  }

  private launch(): void {
    const meta = this.meta;
    if (!meta || meta.stopping) return;

    meta.attempts += 1;
    const args = buildFfmpegArgs({
      ffmpegBin: meta.opts.ffmpegBin,
      inputUrl: meta.opts.inputUrl,
      outDir: meta.opts.outDir,
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
      if (meta.stopping) {
        this.finishEnded();
        return;
      }
      meta.callbacks.onLog?.(`ffmpeg exited (code=${code ?? "?"}, signal=${signal ?? "?"})`);
      if (meta.attempts >= MAX_RETRY_ATTEMPTS) {
        this.finish("fatal");
        return;
      }
      meta.retryTimer = setTimeout(() => {
        meta.retryTimer = null;
        this.launch();
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

  /** Segment names currently on disk, across all rungs: "720/seg_000012.ts" etc. */
  private listSegments(outDir: string): Set<string> {
    const names = new Set<string>();
    for (const rung of ["720", "480", "360"]) {
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

    const segments = this.listSegments(meta.opts.outDir);

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

  private finish(reason: "stopped" | "ingest_timeout" | "fatal"): void {
    const meta = this.meta;
    if (!meta) return;
    // Record the reason before any exit handler can run: the FFmpeg exit handler
    // calls finishEnded() synchronously for an already-dead child.
    this.endedReason = reason;
    meta.stopping = true;
    if (meta.monitorTimer) clearInterval(meta.monitorTimer);
    if (meta.retryTimer) clearTimeout(meta.retryTimer);
    if (meta.ingestTimer) clearTimeout(meta.ingestTimer);
    meta.monitorTimer = meta.retryTimer = meta.ingestTimer = null;

    const child = meta.ffmpeg;
    if (child) {
      child.kill("SIGINT");
      const force = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 5000);
      force.unref?.();
    }
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
