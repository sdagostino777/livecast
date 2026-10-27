import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { createStreamRow, getActiveStream, setStreamStatus } from "../src/streams.js";
import { SignalWatchdog } from "../src/services/watchdog.js";
import type { PipelineApi } from "../src/services/pipeline.js";

function fakePipeline(active = true): PipelineApi {
  let running = active;
  return {
    status: "live",
    lastExit: null,
    isActive: () => running,
    startedAt: () => Date.now(),
    attempts: () => 1,
    currentInput: () => "primary",
    caps: () => ({ video: true, audio: true }),
    start: () => undefined,
    stop: () => {
      running = false;
    },
  };
}

describe("SignalWatchdog", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "livecast-watchdog-"));
    db = openDb(path.join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(readySequence: boolean[]) {
    const stream = createStreamRow(db, { title: "Evento", kind: "video", record: false, createdBy: null });
    setStreamStatus(db, stream.id, "live");
    let call = 0;
    const mediamtx = {
      getPath: vi.fn(async () => ({ ready: readySequence[Math.min(call++, readySequence.length - 1)] ?? false, readers: 0, source: null })),
    };
    let now = 1_000_000;
    const pipeline = fakePipeline();
    const watchdog = new SignalWatchdog({
      db,
      pipeline,
      mediamtx: mediamtx as never,
      primaryPath: "live",
      backupPath: "backup",
      graceMs: 20_000,
      now: () => now,
    });
    return { watchdog, pipeline, advance: (ms: number) => (now += ms), stream };
  }

  it("keeps the broadcast while a publisher is present", async () => {
    const { watchdog, advance } = setup([true]);
    await watchdog.tick();
    advance(60_000);
    await watchdog.tick();
    expect(getActiveStream(db)?.status).toBe("live");
  });

  it("ends the broadcast after the grace period without a publisher", async () => {
    const { watchdog, pipeline, advance } = setup([false]);
    await watchdog.tick(); // starts the clock
    expect(getActiveStream(db)?.status).toBe("live");
    advance(21_000);
    await watchdog.tick();
    expect(pipeline.isActive()).toBe(false);
    expect(getActiveStream(db)).toBeNull();
  });

  it("ignores an unreachable media server instead of guessing", async () => {
    const stream = createStreamRow(db, { title: "Evento", kind: "video", record: false, createdBy: null });
    setStreamStatus(db, stream.id, "live");
    const watchdog = new SignalWatchdog({
      db,
      pipeline: fakePipeline(),
      mediamtx: { getPath: async () => null } as never,
      primaryPath: "live",
      backupPath: "backup",
      graceMs: 1,
    });
    await watchdog.tick();
    expect(getActiveStream(db)?.status).toBe("live");
  });
});
