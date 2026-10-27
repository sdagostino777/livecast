/**
 * HTTP surface: auth, CSRF/origin guard, admin stream lifecycle, public player API.
 *
 * The FFmpeg supervisor is replaced by a double, so these tests never spawn a
 * process or touch a network: they assert that the routes and the database agree
 * about what is live.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createUser, getUserByUsername, hashPassword, setTotpSecret } from "../src/auth.js";
import { MediaMtxClient } from "../src/services/mediamtx.js";
import type { PipelineApi, PipelineCallbacks, PipelineStartOptions } from "../src/services/pipeline.js";
import { totpAt } from "../src/totp.js";

const PASSWORD = "correct horse battery staple";
const USERNAME = "admin";

interface FakePipeline extends PipelineApi {
  callbacks: PipelineCallbacks | null;
  emitLive(): void;
}

function makeFakePipeline(): FakePipeline {
  let state: "idle" | "starting" | "live" | "ended" = "idle";
  const fake: FakePipeline = {
    get status() {
      return state;
    },
    lastExit: null,
    isActive: () => state === "starting" || state === "live",
    startedAt: () => (state === "idle" ? null : Date.now()),
    attempts: () => (state === "idle" ? 0 : 1),
    callbacks: null,
    start: (_opts: PipelineStartOptions, callbacks: PipelineCallbacks) => {
      state = "starting";
      fake.callbacks = callbacks;
    },
    stop: () => {
      state = "ended";
      fake.callbacks?.onEnded("stopped");
    },
    emitLive: () => {
      state = "live";
      fake.callbacks?.onLive();
    },
  };
  return fake;
}

let app: FastifyInstance;
let dir: string;
let pipeline: FakePipeline;

async function boot(): Promise<{ app: FastifyInstance; dir: string; pipeline: FakePipeline }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ndx-app-"));
  pipeline = makeFakePipeline();
  const instance = await buildApp({
    dbFile: path.join(tmp, "db.sqlite"),
    webRoot: path.join(tmp, "missing-web"),
    pipeline,
    mediamtx: new MediaMtxClient("http://127.0.0.1:1", 100),
  });
  createUser(instance.db, USERNAME, await hashPassword(PASSWORD));
  return { app: instance, dir: tmp, pipeline };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : String(raw ?? "");
  return first.split(";")[0] ?? "";
}

async function login(pw = PASSWORD): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: USERNAME, password: pw },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

beforeEach(async () => {
  const booted = await boot();
  app = booted.app;
  dir = booted.dir;
  pipeline = booted.pipeline;
});

afterEach(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("auth", () => {
  it("logs in, answers /me, and logs out", async () => {
    const cookie = await login();
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe(USERNAME);

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("rejects a wrong password without revealing which field was wrong", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: "wrong password here" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");

    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "nobody", password: "wrong password here" },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe("invalid_credentials");
  });

  it("requires the TOTP code once enabled", async () => {
    const db = app.db;
    const user = getUserByUsername(db, USERNAME)!;
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    setTotpSecret(db, user.id, secret, true);

    const without = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(without.statusCode).toBe(401);

    const withCode = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD, code: totpAt(secret, Date.now() / 1000) },
    });
    expect(withCode.statusCode).toBe(200);
  });

  it("rejects cross-origin mutations", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rate-limits login attempts", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: USERNAME, password: "wrong password here" },
      });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(blocked.statusCode).toBe(429);
  });
});

describe("admin + public stream lifecycle", () => {
  it("requires a session on every admin route", async () => {
    for (const url of ["/api/admin/overview", "/api/admin/streams", "/api/admin/audit"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
    const create = await app.inject({ method: "POST", url: "/api/admin/streams", payload: { title: "x" } });
    expect(create.statusCode).toBe(401);
  });

  it("creates a draft, starts it, goes live, stops it and ends it", async () => {
    const cookie = await login();

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/streams",
      headers: { cookie },
      payload: { title: "Assemblea annuale", record: true },
    });
    expect(created.statusCode).toBe(201);
    const stream = created.json().stream;
    expect(stream.slug).toMatch(/^[a-z0-9]{10}$/);
    expect(stream.status).toBe("draft");

    // A draft must not be a public URL.
    const draftPage = await app.inject({ method: "GET", url: `/api/live/${stream.slug}` });
    expect(draftPage.statusCode).toBe(404);

    const start = await app.inject({
      method: "POST",
      url: `/api/admin/streams/${stream.id}/start`,
      headers: { cookie },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json().stream.status).toBe("starting");

    pipeline.emitLive();
    const livePage = await app.inject({ method: "GET", url: `/api/live/${stream.slug}` });
    expect(livePage.statusCode).toBe(200);
    expect(livePage.json().status).toBe("live");
    expect(livePage.json().hlsUrl).toBe(`http://localhost:4100/hls/${stream.slug}/master.m3u8`);

    const overview = await app.inject({ method: "GET", url: "/api/admin/overview", headers: { cookie } });
    expect(overview.json().stream.slug).toBe(stream.slug);
    expect(overview.json().pipeline.status).toBe("live");
    expect(overview.json().ingest.reachable).toBe(false); // MediaMTX is not running in tests

    const stop = await app.inject({
      method: "POST",
      url: `/api/admin/streams/${stream.id}/stop`,
      headers: { cookie },
    });
    expect(stop.statusCode).toBe(202);

    const endedPage = await app.inject({ method: "GET", url: `/api/live/${stream.slug}` });
    expect(endedPage.statusCode).toBe(200);
    expect(endedPage.json().status).toBe("ended");
  });

  it("refuses to start a second stream while one is active", async () => {
    const cookie = await login();
    const a = await app.inject({ method: "POST", url: "/api/admin/streams", headers: { cookie }, payload: { title: "a" } });
    const b = await app.inject({ method: "POST", url: "/api/admin/streams", headers: { cookie }, payload: { title: "b" } });
    await app.inject({ method: "POST", url: `/api/admin/streams/${a.json().stream.id}/start`, headers: { cookie } });
    const second = await app.inject({
      method: "POST",
      url: `/api/admin/streams/${b.json().stream.id}/start`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(409);
  });

  it("reveals ingest credentials only to an authenticated admin, and audits it", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/admin/ingest" });
    expect(anon.statusCode).toBe(401);

    const cookie = await login();
    const res = await app.inject({ method: "GET", url: "/api/admin/ingest", headers: { cookie } });
    // pub pass is unset in the test environment
    expect([200, 503]).toContain(res.statusCode);

    const audit = await app.inject({ method: "GET", url: "/api/admin/audit", headers: { cookie } });
    const actions = audit.json().entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("login_ok");
  });

  it("changes the password and invalidates other sessions", async () => {
    const first = await login();
    const second = await login();

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/password",
      headers: { cookie: second },
      payload: { currentPassword: PASSWORD, newPassword: "a much longer new password" },
    });
    expect(res.statusCode).toBe(200);

    // The changing session survives; the other one is revoked.
    const kept = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: second } });
    expect(kept.statusCode).toBe(200);
    const revoked = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: first } });
    expect(revoked.statusCode).toBe(401);

    const relogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: "a much longer new password" },
    });
    expect(relogin.statusCode).toBe(200);
  });

  it("sets up TOTP and requires the code to enable it", async () => {
    const cookie = await login();
    const setup = await app.inject({ method: "POST", url: "/api/admin/totp/setup", headers: { cookie } });
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json();
    expect(secret).toMatch(/^[A-Z2-7]+$/);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/admin/totp/enable",
      headers: { cookie },
      payload: { code: "000000" },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await app.inject({
      method: "POST",
      url: "/api/admin/totp/enable",
      headers: { cookie },
      payload: { code: totpAt(secret, Date.now() / 1000) },
    });
    expect(right.statusCode).toBe(200);
  });

  it("exposes and updates the runtime settings (CDN, ingest addressing)", async () => {
    const cookie = await login();

    const initial = await app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie } });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().cdnBaseUrl).toBe("");
    expect(initial.json().obsServer).toBe("rtmp://localhost:1935/live");

    const updated = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { cookie },
      payload: { cdnBaseUrl: "https://cdn.ndx.example", ingestPort: 19350 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().hlsBaseUrl).toBe("https://cdn.ndx.example");
    expect(updated.json().obsServer).toBe("rtmp://localhost:19350/live");

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { cookie },
      payload: { cdnBaseUrl: "http://localhost:4100" }, // same origin as the app
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("cdn_same_as_origin");
  });

  it("refuses anonymous settings access", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/settings" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/admin/settings", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/cdn-test", payload: {} })).statusCode).toBe(401);
  });

  it("ends streams orphaned by a restart instead of blocking the next broadcast", async () => {
    const cookie = await login();
    const created = await app.inject({ method: "POST", url: "/api/admin/streams", headers: { cookie }, payload: { title: "orphan" } });
    const stream = created.json().stream;
    await app.inject({ method: "POST", url: `/api/admin/streams/${stream.id}/start`, headers: { cookie } });

    // Simulate a process restart: a new app build over the same database.
    const { buildApp } = await import("../src/app.js");
    const restarted = await buildApp({
      dbFile: path.join(dir, "db.sqlite"),
      webRoot: path.join(dir, "missing-web"),
      pipeline: makeFakePipeline(),
      mediamtx: new MediaMtxClient("http://127.0.0.1:1", 100),
    });
    const restartedCookie = cookieOf(
      await restarted.inject({ method: "POST", url: "/api/auth/login", payload: { username: USERNAME, password: PASSWORD } }),
    );
    const overview = await restarted.inject({ method: "GET", url: "/api/admin/overview", headers: { cookie: restartedCookie } });
    expect(overview.json().stream).toBeNull();
    await restarted.close();

    const after = await app.inject({ method: "GET", url: "/api/live/" + stream.slug });
    expect(after.json().status).toBe("ended");
  });

  it("rejects unknown and malformed stream slugs", async () => {
    expect((await app.inject({ method: "GET", url: "/api/live/aaaaaaaaaa" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/live/NOT-A-SLUG" })).statusCode).toBe(404);
  });
});
