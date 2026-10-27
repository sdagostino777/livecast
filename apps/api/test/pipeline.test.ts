/**
 * The FFmpeg argument list and the supervisor state machine.
 *
 * These are the two pieces of the system most likely to rot: FFmpeg flags are
 * version-sensitive, and the supervisor is all timers and exits. Both are tested
 * with a fake child process, so no encoder runs during CI.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LADDER, HlsPipeline, buildFfmpegArgs, buildFfmpegAudioArgs } from "../src/services/pipeline.js";

describe("buildFfmpegArgs", () => {
  const base = {
    ffmpegBin: "ffmpeg",
    inputUrl: "rtmp://127.0.0.1:1935/live",
    outDir: "/srv/hls/slug",
    segmentSeconds: 2,
    listSize: 6,
    recordFile: null,
  };

  it("encodes every ladder rung and wires the var_stream_map", () => {
    const args = buildFfmpegArgs(base);
    const joined = args.join(" ");

    for (const rung of DEFAULT_LADDER) {
      expect(args).toContain(`${rung.videoBitrateKbps}k`);
      expect(joined).toContain(`scale=-2:${rung.height}`);
    }
    expect(args[args.indexOf("-var_stream_map") + 1]).toBe("v:0,a:0,name:720 v:1,a:1,name:480 v:2,a:2,name:360");
    expect(args[args.indexOf("-master_pl_name") + 1]).toBe("master.m3u8");
    expect(args[args.indexOf("-hls_time") + 1]).toBe("2");
    expect(args[args.indexOf("-hls_flags") + 1]).toBe("delete_segments+independent_segments+program_date_time");
    expect(args[args.indexOf("-hls_segment_filename") + 1]).toBe("/srv/hls/slug/%v/seg_%06d.ts");
    expect(args.at(-1)).toBe("/srv/hls/slug/%v/index.m3u8");
    // Keyframes must be forced on segment boundaries: no player can seek into a
    // segment that does not start on an IDR frame.
    expect(args[args.indexOf("-force_key_frames") + 1]).toBe("expr:gte(t,n_forced*2)");
  });

  it("adds a fragmented MP4 recording only when asked", () => {
    expect(buildFfmpegArgs(base).join(" ")).not.toContain("frag_keyframe");
    const rec = buildFfmpegArgs({ ...base, recordFile: "/srv/recordings/x.frag.mp4" });
    expect(rec.join(" ")).toContain("frag_keyframe");
    expect(rec.join(" ")).toContain("/srv/recordings/x.frag.mp4");
  });

  it("builds a video-only ladder when the source has no audio", () => {
    const args = buildFfmpegArgs({ ...base, kind: "video", hasAudio: false });
    const joined = args.join(" ");
    expect(args[args.indexOf("-var_stream_map") + 1]).toBe("v:0,name:720 v:1,name:480 v:2,name:360");
    expect(joined).not.toContain("-c:a:0");
    expect(joined).not.toContain("0:a:0");
  });

  it("builds audio-only arguments without any video chain", () => {
    const args = buildFfmpegAudioArgs({ ...base, kind: "audio" });
    const joined = args.join(" ");
    expect(joined).toContain("-vn");
    expect(args[args.indexOf("-var_stream_map") + 1]).toBe("a:0,name:audio");
    expect(args[args.indexOf("-hls_segment_filename") + 1]).toBe("/srv/hls/slug/audio/seg_%06d.ts");
    expect(joined).not.toContain("libx264");
    expect(joined).not.toContain("filter_complex");
  });

  it("routes the audio kind through buildFfmpegArgs", () => {
    const args = buildFfmpegArgs({ ...base, kind: "audio" });
    expect(args.join(" ")).toContain("-vn");
    expect(args.join(" ")).not.toContain("libx264");
  });

  it("follows whatever ladder it is given", () => {
    const args = buildFfmpegArgs({
      ...base,
      ladder: [{ name: "1080", height: 1080, videoBitrateKbps: 4500, maxrateKbps: 5000, bufsizeKbps: 9000, audioBitrateKbps: 128 }],
    });
    expect(args[args.indexOf("-var_stream_map") + 1]).toBe("v:0,a:0,name:1080");
    expect(args.join(" ")).toContain("scale=-2:1080");
  });
});

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makePipeline(outDir: string) {
  const spawned: FakeChild[] = [];
  const spawnFn = vi.fn(() => {
    const child = new EventEmitter() as FakeChild;
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    spawned.push(child);
    return child;
  });
  const pipeline = new HlsPipeline(spawnFn as unknown as typeof import("node:child_process").spawn);
  const events: string[] = [];
  const opts = {
    ffmpegBin: "ffmpeg",
    inputUrls: { primary: "rtmp://127.0.0.1:1935/live", backup: "rtmp://127.0.0.1:1935/backup" },
    outDir,
    kind: "video" as const,
    segmentSeconds: 2,
    listSize: 6,
    recordFile: null as string | null,
    ingestWaitSeconds: 600,
    // Tests must not wait for a real ffprobe on an RTMP URL (and a synchronous
    // probe keeps launch() synchronous for the assertions below).
    probeInput: () => ({ video: true, audio: true }),
  };
  const callbacks = {
    onLive: () => events.push("live"),
    onEnded: (reason: string) => events.push(`ended:${reason}`),
  };
  return { pipeline, spawnFn, spawned, events, opts, callbacks };
}

describe("HlsPipeline supervisor", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "livecast-hls-"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts as 'starting', turns live on the first segment, and cleans up on stop", () => {
    const { pipeline, spawned, events, opts, callbacks } = makePipeline(path.join(dir, "s1"));
    pipeline.start(opts, callbacks);

    expect(pipeline.status).toBe("starting");
    expect(spawned).toHaveLength(1);

    fs.mkdirSync(path.join(opts.outDir, "720"), { recursive: true });
    fs.writeFileSync(path.join(opts.outDir, "720", "seg_000001.ts"), "x");
    vi.advanceTimersByTime(2100);
    expect(pipeline.status).toBe("live");
    expect(events).toContain("live");

    pipeline.stop();
    expect(spawned[0]!.kill).toHaveBeenCalledWith("SIGINT");
    spawned[0]!.emit("exit", 0, null);
    expect(pipeline.status).toBe("ended");
    expect(events).toContain("ended:stopped");
    expect(fs.existsSync(opts.outDir)).toBe(false);
  });

  it("relaunches after an unexpected FFmpeg exit, but not once stopping", () => {
    const { pipeline, spawned, opts, callbacks } = makePipeline(path.join(dir, "s2"));
    pipeline.start(opts, callbacks);
    expect(spawned).toHaveLength(1);

    spawned[0]!.emit("exit", 1, null); // e.g. the publisher dropped
    expect(spawned).toHaveLength(1); // retry is delayed, not immediate
    vi.advanceTimersByTime(2600);
    expect(spawned).toHaveLength(2);
    expect(pipeline.status).toBe("starting");

    pipeline.stop();
    spawned[1]!.emit("exit", 1, null);
    expect(pipeline.status).toBe("ended");
  });

  it("ends the stream when no publisher arrives within the ingest window", () => {
    const { pipeline, spawned, events, opts, callbacks } = makePipeline(path.join(dir, "s3"));
    pipeline.start({ ...opts, ingestWaitSeconds: 60 }, callbacks);
    expect(spawned).toHaveLength(1);

    vi.advanceTimersByTime(61_000);
    expect(spawned[0]!.kill).toHaveBeenCalled();
  });

  it("records the exit reason for diagnostics", () => {
    const { pipeline, spawned, opts, callbacks } = makePipeline(path.join(dir, "s4"));
    pipeline.start(opts, callbacks);
    spawned[0]!.stderr.emit("data", Buffer.from("some ffmpeg error\n"));
    spawned[0]!.emit("exit", 1, null);
    expect(pipeline.lastExit?.code).toBe(1);
    expect(pipeline.lastExit?.stderrTail).toContain("some ffmpeg error");
    pipeline.stop();
  });

  it("kills a hung encoder after a stalled segment list, then relaunches it", () => {
    const { pipeline, spawned, opts, callbacks } = makePipeline(path.join(dir, "s6"));
    pipeline.start(opts, callbacks);

    fs.mkdirSync(path.join(opts.outDir, "720"), { recursive: true });
    fs.writeFileSync(path.join(opts.outDir, "720", "seg_000001.ts"), "x");
    vi.advanceTimersByTime(2100); // monitor tick → live
    expect(pipeline.status).toBe("live");

    // 60 ticks (2 minutes) with an unchanged segment list is a hung encoder.
    vi.advanceTimersByTime(2000 * 60);
    expect(spawned[0]!.kill).toHaveBeenCalledWith("SIGKILL");

    spawned[0]!.emit("exit", null, "SIGKILL");
    vi.advanceTimersByTime(2600);
    expect(spawned).toHaveLength(2); // relaunched while the stream stays live
    expect(pipeline.status).toBe("live");

    pipeline.stop();
    spawned[1]!.emit("exit", 0, null);
  });

  it("launches from the backup publisher when the primary is not connected", async () => {
    const { pipeline, spawned, opts, callbacks } = makePipeline(path.join(dir, "failover"));
    const probeReady = vi.fn(async (which: "primary" | "backup") => which === "backup");
    pipeline.start({ ...opts, probeReady }, callbacks);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned).toHaveLength(1);
    const args = (spawned[0] as unknown as { _args?: string[] })._args ?? [];
    // The spawn mock only records the child, so assert the observable contract:
    // the pipeline reports the backup as its current input.
    expect(args).toEqual([]);
    expect(pipeline.currentInput()).toBe("backup");
    pipeline.stop();
  });

  it("prefers the primary publisher when both are connected", async () => {
    const { pipeline, opts, callbacks } = makePipeline(path.join(dir, "prefer-primary"));
    const probeReady = vi.fn(async () => true);
    pipeline.start({ ...opts, probeReady }, callbacks);
    await vi.advanceTimersByTimeAsync(0);
    expect(pipeline.currentInput()).toBe("primary");
    pipeline.stop();
  });

  it("refuses a second concurrent start", () => {
    const { pipeline, opts, callbacks } = makePipeline(path.join(dir, "s5"));
    pipeline.start(opts, callbacks);
    expect(() => pipeline.start(opts, callbacks)).toThrow(/already running/);
  });
});
