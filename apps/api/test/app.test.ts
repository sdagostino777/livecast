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
import { hlsDir } from "../src/config.js";
import { createUser, getUserByUsername, hashPassword } from "../src/auth.js";
import { MediaMtxClient } from "../src/services/mediamtx.js";
import type { PipelineApi, PipelineCallbacks, PipelineStartOptions } from "../src/services/pipeline.js";

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
    currentInput: () => (state === "idle" ? null : "primary"),
    caps: () => ({ video: true, audio: true }),
  };
  return fake;
}

let app: FastifyInstance;
let dir: string;
let pipeline: FakePipeline;

async function boot(): Promise<{ app: FastifyInstance; dir: string; pipeline: FakePipeline }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "livecast-app-"));
  pipeline = makeFakePipeline();
  // A minimal SPA shell, so the tests see the same HTML path production serves
  // (link previews are built from it).
  const webRoot = path.join(tmp, "web");
  fs.mkdirSync(webRoot, { recursive: true });
  fs.writeFileSync(
    path.join(webRoot, "index.html"),
    "<!doctype html><html><head><title>Shell</title></head><body><div id=root></div></body></html>",
  );
  const instance = await buildApp({
    dbFile: path.join(tmp, "db.sqlite"),
    webRoot,
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

  it("rejects cross-origin mutations", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not lock the operator out after a burst of mistakes", async () => {
    // The limit exists to slow an attacker down, not to lock the panel: after a
    // dozen wrong passwords the correct one must still work.
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: USERNAME, password: "wrong password here" },
      });
      expect(res.statusCode).toBe(401);
    }
    const correct = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: PASSWORD },
    });
    expect(correct.statusCode).toBe(200);
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

    // The shared link answers before the broadcast starts: viewers open it
    // early and must see the event name and artwork while they wait.
    const draftPage = await app.inject({ method: "GET", url: `/api/live/${stream.slug}` });
    expect(draftPage.statusCode).toBe(200);
    expect(draftPage.json().status).toBe("draft");
    expect(draftPage.json().posterUrl).toBe(`/api/poster/${stream.slug}`);

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

  it("keeps exactly one broadcast: a new one replaces the configuration", async () => {
    const cookie = await login();
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/streams",
      headers: { cookie },
      payload: { title: "prima" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/admin/streams",
      headers: { cookie },
      payload: { title: "seconda" },
    });
    expect(second.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/api/admin/streams", headers: { cookie } });
    const rows = list.json().streams as Array<{ id: string; title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("seconda");
    expect(rows.some((row) => row.id === first.json().stream.id)).toBe(false);

    // While on air a new configuration is refused.
    await app.inject({ method: "POST", url: `/api/admin/streams/${rows[0]!.id}/start`, headers: { cookie } });
    pipeline.emitLive();
    const whileLive = await app.inject({
      method: "POST",
      url: "/api/admin/streams",
      headers: { cookie },
      payload: { title: "terza" },
    });
    expect(whileLive.statusCode).toBe(409);
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

  it("exposes and updates the runtime settings (CDN, ingest addressing)", async () => {
    const cookie = await login();

    const initial = await app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie } });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().cdnBaseUrl).toBe("");
    expect(initial.json().serverUrl).toBe("rtmp://localhost:1935/live");

    const updated = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { cookie },
      payload: { cdnBaseUrl: "https://cdn.example", ingestPort: 19350 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().hlsBaseUrl).toBe("https://cdn.example");
    expect(updated.json().serverUrl).toBe("rtmp://localhost:19350/live");

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

  it("creates an audio-only broadcast and exposes its kind", async () => {
    const cookie = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/streams",
      headers: { cookie },
      payload: { title: "Radio assemblea", kind: "audio" },
    });
    expect(created.statusCode).toBe(201);
    const stream = created.json().stream;
    expect(stream.kind).toBe("audio");

    await app.inject({ method: "POST", url: `/api/admin/streams/${stream.id}/start`, headers: { cookie } });
    pipeline.emitLive();
    const page = await app.inject({ method: "GET", url: `/api/live/${stream.slug}` });
    expect(page.statusCode).toBe(200);
    expect(page.json().kind).toBe("audio");
    expect(page.json().hlsUrl).toContain(`/hls/${stream.slug}/master.m3u8`);
  });

  it("lets an operator run broadcasts but not manage users", async () => {
    const adminCookie = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: adminCookie },
      payload: { username: "mario", password: "operator password 123" },
    });
    expect(created.statusCode).toBe(201);

    const operatorLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "mario", password: "operator password 123" },
    });
    expect(operatorLogin.statusCode).toBe(200);
    const operatorCookie = cookieOf(operatorLogin);
    expect(operatorLogin.json().user.role).toBe("operator");

    const overview = await app.inject({ method: "GET", url: "/api/admin/overview", headers: { cookie: operatorCookie } });
    expect(overview.statusCode).toBe(200);

    const usersDenied = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: operatorCookie } });
    expect(usersDenied.statusCode).toBe(403);

    const stream = await app.inject({
      method: "POST",
      url: "/api/admin/streams",
      headers: { cookie: operatorCookie },
      payload: { title: "da operatore" },
    });
    expect(stream.statusCode).toBe(201);
  });

  it("manages operator accounts, and never the admin one", async () => {
    const cookie = await login();

    const reserved = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie },
      payload: { username: "admin", password: "another password 123" },
    });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json().error).toBe("reserved_username");

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie },
      payload: { username: "lucia", password: "initial password 123" },
    });
    expect(created.statusCode).toBe(201);
    const userId = created.json().user.id;

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie },
      payload: { username: "lucia", password: "initial password 123" },
    });
    expect(duplicate.statusCode).toBe(409);

    const list = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } });
    const adminRow = (list.json().users as Array<{ id: string; role: string }>).find((u) => u.role === "admin")!;
    expect(adminRow).toBeTruthy();

    const protectedReset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${adminRow.id}/password`,
      headers: { cookie },
      payload: { password: "hijacked password 123" },
    });
    expect(protectedReset.statusCode).toBe(403);
    expect(protectedReset.json().error).toBe("admin_account_protected");

    const protectedDelete = await app.inject({ method: "DELETE", url: `/api/admin/users/${adminRow.id}`, headers: { cookie } });
    expect(protectedDelete.statusCode).toBe(403);

    const reset = await app.inject({
      method: "POST",
      url: `/api/admin/users/${userId}/password`,
      headers: { cookie },
      payload: { password: "brand new password 123" },
    });
    expect(reset.statusCode).toBe(200);

    const oldPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "lucia", password: "initial password 123" },
    });
    expect(oldPassword.statusCode).toBe(401);
    const newPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "lucia", password: "brand new password 123" },
    });
    expect(newPassword.statusCode).toBe(200);

    const removed = await app.inject({ method: "DELETE", url: `/api/admin/users/${userId}`, headers: { cookie } });
    expect(removed.statusCode).toBe(200);
    const afterDelete = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } });
    expect((afterDelete.json().users as Array<{ username: string }>).some((u) => u.username === "lucia")).toBe(false);
  });

  it("reports connectivity checks for the panel LEDs", async () => {
    const cookie = await login();
    const res = await app.inject({ method: "GET", url: "/api/admin/checks", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("origin.ok");
    expect(body.origin.ok).toBe(false); // no listener in the test environment
    expect(body.cdnEnabled).toBe(false);
    expect(body.cdn).toBeNull();
    expect(body.ingestTcp).toBe(false);
    const anon = await app.inject({ method: "GET", url: "/api/admin/checks" });
    expect(anon.statusCode).toBe(401);
  });

  it("accepts a poster upload, serves it, and removes it", async () => {
    const cookie = await login();
    const created = await app.inject({ method: "POST", url: "/api/admin/streams", headers: { cookie }, payload: { title: "Evento con poster" } });
    const stream = created.json().stream;

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/admin/streams/${stream.id}/poster`,
      headers: { cookie, "content-type": "image/png" },
      payload: png,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().stream.posterImageUrl).toBe(`/uploads/${stream.slug}.poster.png`);
    expect(uploaded.json().stream.posterUrl).toBe(`/api/poster/${stream.slug}`);

    const served = await app.inject({ method: "GET", url: uploaded.json().stream.posterImageUrl });
    expect(served.statusCode).toBe(200);

    // Without the overlay the artwork is the uploaded file itself…
    const plainArtwork = await app.inject({ method: "GET", url: `/api/poster/${stream.slug}` });
    expect(plainArtwork.statusCode).toBe(200);
    expect(plainArtwork.headers["content-type"]).toContain("image/png");

    // …and with it, an SVG that embeds the image and draws the title.
    const overlay = await app.inject({
      method: "PATCH",
      url: `/api/admin/streams/${stream.id}`,
      headers: { cookie },
      payload: { posterOverlay: true },
    });
    expect(overlay.statusCode).toBe(200);
    expect(overlay.json().stream.posterOverlay).toBe(true);
    const composedArtwork = await app.inject({ method: "GET", url: `/api/poster/${stream.slug}` });
    expect(composedArtwork.headers["content-type"]).toContain("image/svg+xml");
    expect(composedArtwork.body).toContain("Evento con poster");
    // The picture travels inside the SVG: an <img>-loaded SVG cannot fetch an
    // external href, which is what made the preview look empty.
    expect(composedArtwork.body).toContain("data:image/png;base64,");

    const bogus = await app.inject({
      method: "POST",
      url: `/api/admin/streams/${stream.id}/poster`,
      headers: { cookie, "content-type": "image/png" },
      payload: Buffer.from("not an image at all"),
    });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error).toBe("unsupported_image_format");

    const anonymous = await app.inject({
      method: "POST",
      url: `/api/admin/streams/${stream.id}/poster`,
      headers: { "content-type": "image/png" },
      payload: png,
    });
    expect(anonymous.statusCode).toBe(401);

    const removed = await app.inject({ method: "DELETE", url: `/api/admin/streams/${stream.id}/poster`, headers: { cookie } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().stream.posterImageUrl).toBeNull();
  });

  it("freezes title and palette once on air, and allows them again when ended", async () => {
    const cookie = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/streams",
      headers: { cookie },
      payload: { title: "Congresso Internazionale 2027 — Bologna", kind: "video" },
    });
    const stream = created.json().stream;

    // Before going live everything is editable.
    const renamedEarly = await app.inject({
      method: "PATCH",
      url: `/api/admin/streams/${stream.id}`,
      headers: { cookie },
      payload: { title: "Congresso Internazionale 2027 — Bologna", posterPalette: "teal" },
    });
    expect(renamedEarly.statusCode).toBe(200);
    expect(renamedEarly.json().stream.title).toBe("Congresso Internazionale 2027 — Bologna");
    expect(renamedEarly.json().stream.posterPalette).toBe("teal");

    await app.inject({ method: "POST", url: `/api/admin/streams/${stream.id}/start`, headers: { cookie } });
    pipeline.emitLive();

    // On air: the identity is frozen, including the artwork.
    const renamedLive = await app.inject({
      method: "PATCH",
      url: `/api/admin/streams/${stream.id}`,
      headers: { cookie },
      payload: { title: "Cambio in diretta" },
    });
    expect(renamedLive.statusCode).toBe(409);
    expect(renamedLive.json().error).toBe("stream_on_air");

    const paletteLive = await app.inject({
      method: "PATCH",
      url: `/api/admin/streams/${stream.id}`,
      headers: { cookie },
      payload: { posterPalette: "blue" },
    });
    expect(paletteLive.statusCode).toBe(409);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const uploadLive = await app.inject({
      method: "POST",
      url: `/api/admin/streams/${stream.id}/poster`,
      headers: { cookie, "content-type": "image/png" },
      payload: png,
    });
    expect(uploadLive.statusCode).toBe(409);

    const kindLive = await app.inject({
      method: "PATCH",
      url: `/api/admin/streams/${stream.id}`,
      headers: { cookie },
      payload: { kind: "audio" },
    });
    expect(kindLive.statusCode).toBe(409);

    // Ended: editing is allowed again.
    await app.inject({ method: "POST", url: `/api/admin/streams/${stream.id}/stop`, headers: { cookie } });
    const renamedEnded = await app.inject({
      method: "PATCH",
      url: `/api/admin/streams/${stream.id}`,
      headers: { cookie },
      payload: { title: "Congresso Internazionale 2027 — Bologna — replica" },
    });
    expect(renamedEnded.statusCode).toBe(200);
  });

  it("issues recovery codes on password change and redeems them without a session", async () => {
    const cookie = await login();
    const changed = await app.inject({
      method: "POST",
      url: "/api/admin/password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: "a much longer new password" },
    });
    expect(changed.statusCode).toBe(200);
    const codes = changed.json().recoveryCodes as string[];
    expect(codes).toHaveLength(8);
    expect(codes[0]).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);

    const remaining = await app.inject({ method: "GET", url: "/api/admin/recovery-codes", headers: { cookie } });
    expect(remaining.json().remaining).toBe(8);

    // A wrong code changes nothing.
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: { username: USERNAME, code: "AAAAA-AAAAA", newPassword: "another long password 1" },
    });
    expect(wrong.statusCode).toBe(401);

    // The printed code resets the password and invalidates the session.
    const recovered = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: {
        username: USERNAME,
        code: codes[0]!.toLowerCase().replace("-", " "), // forgiving input
        newPassword: "recovered password 123456",
      },
    });
    expect(recovered.statusCode).toBe(200);

    const oldSession = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(oldSession.statusCode).toBe(401);

    const newPasswordWorks = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: USERNAME, password: "recovered password 123456" },
    });
    expect(newPasswordWorks.statusCode).toBe(200);

    // A code is single use.
    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/recover",
      payload: { username: USERNAME, code: codes[0]!, newPassword: "yet another password 1" },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("keeps every word of a long event title on the poster", async () => {
    const cookie = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/streams",
      headers: { cookie },
      payload: { title: "Congresso Internazionale 2027 — Bologna" },
    });
    const stream = created.json().stream;
    const poster = await app.inject({ method: "GET", url: `/api/poster/${stream.slug}` });
    expect(poster.statusCode).toBe(200);
    // The two-line poster used to drop the tail of a long title.
    for (const word of ["Congresso", "Internazionale", "2027", "Bologna"]) {
      expect(poster.body).toContain(word);
    }
    // …and it stays on one line when the type can shrink to fit.
    const titleNodes = [...poster.body.matchAll(/<text[^>]*>([^<]+)<\/text>/g)]
      .map((m) => m[1]!)
      .filter((text) => !["LIVECAST", "LIVE"].includes(text));
    expect(titleNodes).toEqual(["Congresso Internazionale 2027 — Bologna"]);
  });

  it("generates poster artwork when no image was uploaded", async () => {
    const cookie = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/streams",
      headers: { cookie },
      payload: { title: "Congresso Internazionale 2027 — Bologna" },
    });
    const stream = created.json().stream;
    expect(stream.fallbackPosterUrl).toBe(`/api/poster/${stream.slug}`);
    expect(stream.posterUrl).toBe(`/api/poster/${stream.slug}`);
    expect(stream.posterImageUrl).toBeNull();

    // The template is public from the start, which is what the shared link shows.
    const draftPoster = await app.inject({ method: "GET", url: `/api/poster/${stream.slug}` });
    expect(draftPoster.statusCode).toBe(200);
    expect(draftPoster.body).toContain("Congresso");

    // The admin variant works for any status.
    const adminPoster = await app.inject({ method: "GET", url: `/api/admin/poster/${stream.id}`, headers: { cookie } });
    expect(adminPoster.statusCode).toBe(200);
    expect(adminPoster.headers["content-type"]).toContain("image/svg+xml");
    expect(adminPoster.body).toContain("Congresso");

    const anonPoster = await app.inject({ method: "GET", url: `/api/admin/poster/${stream.id}` });
    expect(anonPoster.statusCode).toBe(401);

    // Once public, the generated poster is served without a session.
    await app.inject({ method: "POST", url: `/api/admin/streams/${stream.id}/start`, headers: { cookie } });
    pipeline.emitLive();
    const publicPoster = await app.inject({ method: "GET", url: `/api/poster/${stream.slug}` });
    expect(publicPoster.statusCode).toBe(200);
    expect(publicPoster.body.startsWith("<svg")).toBe(true);
  });

  it("lets the install rename itself and upload its own logo", async () => {
    const cookie = await login();
    const before = await app.inject({ method: "GET", url: "/api/brand" });
    expect(before.json().logoUrl).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/brand/logo" })).statusCode).toBe(404);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const upload = await app.inject({
      method: "POST",
      url: "/api/admin/brand/logo",
      headers: { cookie, "content-type": "image/png" },
      payload: png,
    });
    expect(upload.statusCode).toBe(200);

    const served = await app.inject({ method: "GET", url: "/api/brand/logo" });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");

    const renamed = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { cookie },
      payload: { brandName: "Radio Comunale" },
    });
    expect(renamed.statusCode).toBe(200);
    const brand = await app.inject({ method: "GET", url: "/api/brand" });
    expect(brand.json().name).toBe("Radio Comunale");
    expect(brand.json().logoUrl).toBe("/api/brand/logo");

    // A logo that is not an image is refused, and the old one survives.
    const bogus = await app.inject({
      method: "POST",
      url: "/api/admin/brand/logo",
      headers: { cookie, "content-type": "image/png" },
      payload: Buffer.from("not an image"),
    });
    expect(bogus.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/brand/logo" })).statusCode).toBe(200);

    const removed = await app.inject({ method: "DELETE", url: "/api/admin/brand/logo", headers: { cookie } });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/brand/logo" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/brand" })).json().logoUrl).toBeNull();
  });

  it("gives the shared link a preview a messaging app can read", async () => {
    const cookie = await login();
    const created = await app.inject({ method: "POST", url: "/api/admin/streams", headers: { cookie }, payload: { title: "Serata Jazz" } });
    const stream = created.json().stream;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await app.inject({
      method: "POST",
      url: `/api/admin/streams/${stream.id}/poster`,
      headers: { cookie, "content-type": "image/png" },
      payload: png,
    });

    const page = await app.inject({ method: "GET", url: `/live/${stream.slug}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('property="og:title" content="Serata Jazz');
    // A raster URL, absolute, because that is what a crawler must fetch.
    expect(page.body).toContain(`/uploads/${stream.slug}.poster.png`);
    expect(page.body).toContain('property="og:image"');
    expect(page.body).toContain('name="twitter:card" content="summary_large_image"');

    // Without any upload the title still previews, with no broken image tag.
    const plain = await app.inject({ method: "POST", url: "/api/admin/streams", headers: { cookie }, payload: { title: "Solo Titolo" } });
    const plainPage = await app.inject({ method: "GET", url: `/live/${plain.json().stream.slug}` });
    expect(plainPage.body).toContain('property="og:title" content="Solo Titolo');
    expect(plainPage.body).not.toContain('property="og:image"');
  });

  it("counts the player pages that are open, and forgets the closed ones", async () => {
    const cookie = await login();
    const created = await app.inject({ method: "POST", url: "/api/admin/streams", headers: { cookie }, payload: { title: "Evento contato" } });
    const stream = created.json().stream;
    await app.inject({ method: "POST", url: `/api/admin/streams/${stream.id}/start`, headers: { cookie } });
    pipeline.emitLive();

    const beat = (id: string) =>
      app.inject({ method: "POST", url: `/api/live/${stream.slug}/presence`, payload: { id } });

    expect((await beat("viewer-one")).json().viewers).toBe(1);
    expect((await beat("viewer-two")).json().viewers).toBe(2);
    // The same tab beating again is one viewer, not three.
    expect((await beat("viewer-one")).json().viewers).toBe(2);

    const overview = await app.inject({ method: "GET", url: "/api/admin/overview", headers: { cookie } });
    expect(overview.json().viewers).toBe(2);

    // The panel never shows a number it cannot explain.
    expect((await app.inject({ method: "POST", url: `/api/live/${stream.slug}/presence`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/live/aaaaaaaaaa/presence", payload: { id: "x-viewer" } })).statusCode).toBe(404);
  });

  it("starts every run from an empty output directory", async () => {
    const cookie = await login();
    const created = await app.inject({ method: "POST", url: "/api/admin/streams", headers: { cookie }, payload: { title: "Cambio tipo" } });
    const stream = created.json().stream;
    const outDir = hlsDir(stream.slug);

    // A previous video run left its ladder behind; switching to audio reuses the
    // same link and directory, and stale playlists must not survive the switch.
    fs.mkdirSync(path.join(outDir, "720"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "720", "seg_000001.ts"), "old");
    fs.writeFileSync(path.join(outDir, "master.m3u8"), "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2800000\n720/index.m3u8\n");

    await app.inject({ method: "PATCH", url: `/api/admin/streams/${stream.id}`, headers: { cookie }, payload: { kind: "audio" } });
    await app.inject({ method: "POST", url: `/api/admin/streams/${stream.id}/start`, headers: { cookie } });

    expect(fs.existsSync(path.join(outDir, "master.m3u8"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "720"))).toBe(false);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("freezes the title overlay while on air", async () => {
    const cookie = await login();
    const created = await app.inject({ method: "POST", url: "/api/admin/streams", headers: { cookie }, payload: { title: "Evento overlay" } });
    const stream = created.json().stream;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await app.inject({
      method: "POST",
      url: `/api/admin/streams/${stream.id}/poster`,
      headers: { cookie, "content-type": "image/png" },
      payload: png,
    });
    await app.inject({ method: "POST", url: `/api/admin/streams/${stream.id}/start`, headers: { cookie } });
    pipeline.emitLive();

    const blocked = await app.inject({
      method: "PATCH",
      url: `/api/admin/streams/${stream.id}`,
      headers: { cookie },
      payload: { posterOverlay: true },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("stream_on_air");
  });

  it("rejects unknown and malformed stream slugs", async () => {
    expect((await app.inject({ method: "GET", url: "/api/live/aaaaaaaaaa" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/live/NOT-A-SLUG" })).statusCode).toBe(404);
  });
});
