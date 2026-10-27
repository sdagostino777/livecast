/**
 * Admin API — everything behind `requireSession`.
 *
 * Route layout:
 *   GET    /api/admin/overview            dashboard state in one round-trip
 *   GET    /api/admin/streams             all streams, newest first
 *   POST   /api/admin/streams             create a draft stream
 *   PATCH  /api/admin/streams/:id         edit title/record while still draft
 *   DELETE /api/admin/streams/:id         remove a draft or ended stream
 *   POST   /api/admin/streams/:id/start   arm the pipeline and wait for OBS
 *   POST   /api/admin/streams/:id/stop    stop the active stream
 *   GET    /api/admin/ingest              reveal OBS credentials (audited)
 *   POST   /api/admin/password            change password
 *   POST   /api/admin/totp/setup|enable|disable
 *   GET    /api/admin/audit               recent privileged actions
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { config, hlsDir, recordingsDir } from "../config.js";
import { audit } from "../db.js";
import {
  MIN_PASSWORD_LENGTH,
  createUser,
  deleteUser,
  destroyAllSessions,
  destroyOtherSessions,
  getUserByUsername,
  hashPassword,
  listUsers,
  setPassword,
  verifyPassword,
} from "../auth.js";
import { nowIso } from "../ids.js";
import net from "node:net";
import { requireSession } from "../session.js";
import { createStreamRow, deleteStreamRow, getActiveStream, getStreamById, listStreams, setStreamStatus, toView } from "../streams.js";
import { SettingsPatch } from "../settings.js";
import { ingestServer, ingestServerWithCreds, mediaInputUrl } from "../ingest.js";

const CreateStreamBody = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.enum(["video", "audio"]).default("video"),
  record: z.boolean().optional().default(false),
});

const CreateUserBody = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .refine((v) => /^[a-z0-9._-]+$/i.test(v), "invalid_username"),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

const ResetPasswordBody = z.object({
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

const PatchStreamBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  record: z.boolean().optional(),
});

const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

const CdnTestBody = z.object({
  url: z
    .string()
    .trim()
    .max(300)
    .refine((v) => /^https?:\/\/[a-z0-9.-]+(:\d+)?(\/.*)?$/i.test(v), "invalid_url"),
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

function safeParse<T>(schema: z.ZodType<T>, value: unknown): { ok: true; data: T } | { ok: false } {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

interface ProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
}

interface ChecksPayload {
  origin: ProbeResult;
  cdn: ProbeResult | null;
  ingestTcp: boolean;
  cdnEnabled: boolean;
  pipeline: string;
}

async function probeHttp(url: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "cache-control": "no-cache" } });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "error", ms: Date.now() - started };
  }
}

function probeTcp(host: string, port: number): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port, timeout: 3000 });
    const finish = (result: { ok: boolean; error?: string }) => {
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.once("connect", () => finish({ ok: true }));
    socket.once("error", (err) => finish({ ok: false, error: err.message }));
    socket.once("timeout", () => finish({ ok: false, error: "timeout" }));
  });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/overview", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;

    const settings = app.settings.get();
    const active = getActiveStream(app.db);
    const [primary, backup] = await Promise.all([
      app.mediamtx.getPath(config.ingestPath),
      app.mediamtx.getPath(config.ingestBackupPath),
    ]);
    const startedAtMs = app.pipeline.startedAt();

    return {
      serverTime: nowIso(),
      publicUrl: settings.publicBaseUrl,
      stream: active ? toView(active, settings.publicBaseUrl) : null,
      pipeline: {
        status: app.pipeline.status,
        attempts: app.pipeline.attempts(),
        startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
        lastError: app.pipeline.lastExit?.stderrTail ? app.pipeline.lastExit.stderrTail.slice(-600) : null,
      },
      ingest: {
        // null when MediaMTX's API cannot be reached: the page shows "unknown"
        // instead of claiming the broadcaster is offline.
        reachable: primary !== null || backup !== null,
        ready: primary?.ready ?? false,
        backupReady: backup?.ready ?? false,
        readers: primary?.readers ?? 0,
        currentInput: app.pipeline.currentInput(),
        server: ingestServer(settings),
        backupServer: ingestServer(settings, config.ingestBackupPath),
        publishUser: config.publishUser,
        hasPublishPass: config.publishPass.length > 0,
      },
      cdn: {
        enabled: settings.cdnBaseUrl !== "",
        hlsBaseUrl: app.settings.hlsBaseUrl(),
        publicBaseUrl: settings.publicBaseUrl,
      },
    };
  });

  app.get("/api/admin/ingest", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const url = ingestServerWithCreds(app.settings.get());
    const backupUrl = ingestServerWithCreds(app.settings.get(), config.ingestBackupPath);
    audit(app.db, { userId: session.user.id, username: session.user.username, action: "ingest_key_revealed", ip: req.ip });
    if (!url) return reply.code(503).send({ error: "publish_pass_not_configured" });
    return {
      server: url,
      backupServer: backupUrl,
      // OBS: paste this in "Server" and leave "Stream Key" empty.
      streamKey: "",
      publishUser: config.publishUser,
    };
  });

  // --- runtime settings (CDN / base URLs / ingest addressing) ---------------

  app.get("/api/admin/settings", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const settings = app.settings.get();
    return {
      brandName: settings.brandName,
      publicBaseUrl: settings.publicBaseUrl,
      cdnBaseUrl: settings.cdnBaseUrl,
      ingestHost: settings.ingestHost,
      ingestPort: settings.ingestPort,
      hlsBaseUrl: app.settings.hlsBaseUrl(),
      obsServer: ingestServer(settings),
    };
  });

  app.put("/api/admin/settings", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const parsed = safeParse(SettingsPatch, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request" });
    try {
      const next = app.settings.update(parsed.data);
      audit(app.db, {
        userId: session.user.id,
        username: session.user.username,
        action: "settings_updated",
        detail: JSON.stringify(parsed.data),
        ip: req.ip,
      });
      return {
        brandName: next.brandName,
        publicBaseUrl: next.publicBaseUrl,
        cdnBaseUrl: next.cdnBaseUrl,
        ingestHost: next.ingestHost,
        ingestPort: next.ingestPort,
        hlsBaseUrl: app.settings.hlsBaseUrl(),
        obsServer: ingestServer(next),
      };
    } catch (err) {
      const code = err instanceof Error ? err.message : "invalid_settings";
      return reply.code(400).send({ error: code });
    }
  });

  // --- connectivity checks for the panel's LEDs ---------------------------
  // Answers "is this URL actually working *from the server*", which is the only
  // vantage point that matters: the operator's laptop can reach the CDN while
  // the origin's outbound path is broken, and vice versa.
  const checksCache = new Map<string, { at: number; value: ChecksPayload }>();
  app.get("/api/admin/checks", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const cached = checksCache.get("all");
    if (cached && Date.now() - cached.at < 5000) return cached.value;

    const settings = app.settings.get();
    const [origin, cdn, tcp] = await Promise.all([
      probeHttp(`${settings.publicBaseUrl}/api/health`),
      settings.cdnBaseUrl ? probeHttp(`${settings.cdnBaseUrl}/api/health`) : Promise.resolve(null),
      probeTcp(settings.ingestHost, settings.ingestPort),
    ]);
    const value: ChecksPayload = {
      origin,
      cdn,
      ingestTcp: tcp.ok,
      cdnEnabled: settings.cdnBaseUrl !== "",
      pipeline: app.pipeline.status,
    };
    checksCache.set("all", { at: Date.now(), value });
    return value;
  });

  app.post("/api/admin/cdn-test", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const parsed = safeParse(CdnTestBody, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request" });

    const base = parsed.data.url.replace(/\/+$/, "");
    const active = getActiveStream(app.db);
    // Probe a path a real viewer would fetch: the live manifest through the CDN
    // edge, or the health endpoint when nothing is on air.
    const probe = active ? `${base}/hls/${active.slug}/master.m3u8` : `${base}/hls/`;
    let res: Response;
    try {
      res = await fetch(probe, { method: "GET", signal: AbortSignal.timeout(6000) });
    } catch (err) {
      return reply.send({ ok: false, probe, error: err instanceof Error ? err.message : "fetch_failed" });
    }
    return {
      ok: res.ok,
      probe,
      status: res.status,
      headers: {
        server: res.headers.get("server"),
        "x-cache": res.headers.get("x-cache") ?? res.headers.get("cf-cache-status") ?? res.headers.get("cdn-cache"),
        "cache-control": res.headers.get("cache-control"),
        "content-type": res.headers.get("content-type"),
      },
    };
  });

  app.get("/api/admin/streams", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const base = app.settings.get().publicBaseUrl;
    return { streams: listStreams(app.db).map((row) => toView(row, base)) };
  });

  app.post("/api/admin/streams", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const parsed = safeParse(CreateStreamBody, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request" });
    const row = createStreamRow(app.db, {
      title: parsed.data.title,
      kind: parsed.data.kind ?? "video",
      record: parsed.data.record ?? false,
      createdBy: session.user.id,
    });
    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "stream_created",
      detail: row.slug,
      ip: req.ip,
    });
    return reply.code(201).send({ stream: toView(row, app.settings.get().publicBaseUrl) });
  });

  app.patch("/api/admin/streams/:id", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const params = safeParse(IdParams, req.params);
    const body = safeParse(PatchStreamBody, req.body);
    if (!params.ok || !body.ok) return reply.code(400).send({ error: "invalid_request" });
    const stream = getStreamById(app.db, params.data.id);
    if (!stream) return reply.code(404).send({ error: "not_found" });
    if (stream.status !== "draft") return reply.code(409).send({ error: "stream_not_editable" });
    if (body.data.title !== undefined) {
      app.db.prepare("UPDATE streams SET title = ? WHERE id = ?").run(body.data.title, stream.id);
    }
    if (body.data.record !== undefined) {
      app.db.prepare("UPDATE streams SET record = ? WHERE id = ?").run(body.data.record ? 1 : 0, stream.id);
    }
    return { stream: toView(getStreamById(app.db, stream.id)!, app.settings.get().publicBaseUrl) };
  });

  app.delete("/api/admin/streams/:id", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const params = safeParse(IdParams, req.params);
    if (!params.ok) return reply.code(400).send({ error: "invalid_request" });
    const stream = getStreamById(app.db, params.data.id);
    if (!stream) return reply.code(404).send({ error: "not_found" });
    if (stream.status === "starting" || stream.status === "live") {
      return reply.code(409).send({ error: "stream_active" });
    }
    deleteStreamRow(app.db, stream.id);
    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "stream_deleted",
      detail: stream.slug,
      ip: req.ip,
    });
    return { ok: true };
  });

  app.post("/api/admin/streams/:id/start", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const params = safeParse(IdParams, req.params);
    if (!params.ok) return reply.code(400).send({ error: "invalid_request" });

    const stream = getStreamById(app.db, params.data.id);
    if (!stream) return reply.code(404).send({ error: "not_found" });
    if (app.pipeline.isActive() || getActiveStream(app.db)) {
      return reply.code(409).send({ error: "another_stream_active" });
    }
    if (stream.status !== "draft" && stream.status !== "ended") {
      return reply.code(409).send({ error: "stream_not_startable" });
    }

    const startedAt = nowIso();
    setStreamStatus(app.db, stream.id, "starting", startedAt);
    const recordFile = stream.record
      ? `${recordingsDir()}/${stream.slug}-${startedAt.replace(/[:.]/g, "-")}.frag.mp4`
      : null;

    const streamId = stream.id;
    const slug = stream.slug;
    try {
      app.pipeline.start(
        {
          ffmpegBin: config.ffmpegBin,
          inputUrls: {
            primary: mediaInputUrl(config.ingestPath),
            backup: mediaInputUrl(config.ingestBackupPath),
          },
          probeReady: async (which) => {
            const pathReady = await app.mediamtx.getPath(
              which === "primary" ? config.ingestPath : config.ingestBackupPath,
            );
            return pathReady?.ready ?? false;
          },
          outDir: hlsDir(slug),
          kind: stream.kind,
          segmentSeconds: config.hlsSegmentSeconds,
          listSize: config.hlsListSize,
          recordFile,
          ingestWaitSeconds: config.ingestWaitSeconds,
        },
        {
          onLive: () => {
            setStreamStatus(app.db, streamId, "live");
            audit(app.db, {
              userId: session.user.id,
              username: session.user.username,
              action: "stream_live",
              detail: slug,
            });
          },
          onEnded: (reason) => {
            setStreamStatus(app.db, streamId, "ended");
            audit(app.db, {
              userId: session.user.id,
              username: session.user.username,
              action: "stream_ended",
              detail: `${slug}:${reason}`,
            });
          },
          onLog: (line) => app.log.debug({ slug, line }),
        },
      );
    } catch (err) {
      setStreamStatus(app.db, stream.id, "draft");
      app.log.warn({ err }, "pipeline failed to start");
      return reply.code(409).send({ error: "pipeline_busy" });
    }

    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "stream_start_requested",
      detail: slug,
      ip: req.ip,
    });
    return reply.code(202).send({ stream: toView(getStreamById(app.db, stream.id)!, app.settings.get().publicBaseUrl) });
  });

  app.post("/api/admin/streams/:id/stop", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const params = safeParse(IdParams, req.params);
    if (!params.ok) return reply.code(400).send({ error: "invalid_request" });
    const stream = getStreamById(app.db, params.data.id);
    if (!stream) return reply.code(404).send({ error: "not_found" });
    if (!["starting", "live"].includes(stream.status)) return reply.code(409).send({ error: "stream_not_active" });
    app.pipeline.stop();
    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "stream_stop_requested",
      detail: stream.slug,
      ip: req.ip,
    });
    return reply.code(202).send({ ok: true });
  });

  app.post("/api/admin/password", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const parsed = safeParse(PasswordBody, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request" });

    const user = getUserByUsername(app.db, session.user.username);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
      audit(app.db, { userId: user.id, username: user.username, action: "password_change_failed", ip: req.ip });
      return reply.code(403).send({ error: "invalid_credentials" });
    }
    setPassword(app.db, user.id, await hashPassword(parsed.data.newPassword));
    destroyOtherSessions(app.db, user.id, session.sessionId);
    audit(app.db, { userId: user.id, username: user.username, action: "password_changed", ip: req.ip });
    return { ok: true };
  });

  // --- users ---------------------------------------------------------------
  // Only the admin role manages accounts, and the admin account itself is out
  // of reach: it cannot be deleted or have its password reset from this panel.
  // Its password is changed through /api/admin/password by the person holding
  // the session, which is the only authority over that account.

  app.get("/api/admin/users", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    if (session.user.role !== "admin") return reply.code(403).send({ error: "admin_only" });
    return { users: listUsers(app.db) };
  });

  app.post("/api/admin/users", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    if (session.user.role !== "admin") return reply.code(403).send({ error: "admin_only" });
    const parsed = safeParse(CreateUserBody, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request" });
    const { username, password } = parsed.data;
    if (username.toLowerCase() === "admin") return reply.code(400).send({ error: "reserved_username" });
    if (getUserByUsername(app.db, username)) return reply.code(409).send({ error: "username_taken" });
    const user = createUser(app.db, username, await hashPassword(password), "operator");
    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "user_created",
      detail: user.username,
      ip: req.ip,
    });
    return reply.code(201).send({ user: { id: user.id, username: user.username, role: user.role } });
  });

  app.post("/api/admin/users/:id/password", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    if (session.user.role !== "admin") return reply.code(403).send({ error: "admin_only" });
    const params = safeParse(IdParams, req.params);
    const parsed = safeParse(ResetPasswordBody, req.body);
    if (!params.ok || !parsed.ok) return reply.code(400).send({ error: "invalid_request" });
    const target = app.db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(params.data.id) as
      | { id: string; username: string; role: string }
      | undefined;
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (target.role === "admin") return reply.code(403).send({ error: "admin_account_protected" });
    setPassword(app.db, target.id, await hashPassword(parsed.data.password));
    destroyAllSessions(app.db, target.id);
    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "user_password_reset",
      detail: target.username,
      ip: req.ip,
    });
    return { ok: true };
  });

  app.delete("/api/admin/users/:id", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    if (session.user.role !== "admin") return reply.code(403).send({ error: "admin_only" });
    const params = safeParse(IdParams, req.params);
    if (!params.ok) return reply.code(400).send({ error: "invalid_request" });
    const target = app.db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(params.data.id) as
      | { id: string; username: string; role: string }
      | undefined;
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (target.role === "admin") return reply.code(403).send({ error: "admin_account_protected" });
    if (target.id === session.user.id) return reply.code(400).send({ error: "cannot_delete_self" });
    deleteUser(app.db, target.id);
    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "user_deleted",
      detail: target.username,
      ip: req.ip,
    });
    return { ok: true };
  });

  app.get("/api/admin/audit", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit ?? 50) || 50, 1), 200);
    const rows = app.db
      .prepare(`SELECT action, detail, username, ip, created_at FROM audit_log ORDER BY id DESC LIMIT ?`)
      .all(limit);
    return { entries: rows };
  });
}
