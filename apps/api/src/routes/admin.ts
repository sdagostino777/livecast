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
  destroyOtherSessions,
  getUserByUsername,
  hashPassword,
  setPassword,
  setTotpSecret,
  verifyPassword,
} from "../auth.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../totp.js";
import { nowIso } from "../ids.js";
import { requireSession } from "../session.js";
import { createStreamRow, deleteStreamRow, getActiveStream, getStreamById, listStreams, setStreamStatus, toView } from "../streams.js";
import { SettingsPatch } from "../settings.js";
import { ingestServer, ingestServerWithCreds, mediaInputUrl } from "../ingest.js";

const CreateStreamBody = z.object({
  title: z.string().trim().min(1).max(120),
  record: z.boolean().optional().default(false),
});

const PatchStreamBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  record: z.boolean().optional(),
});

const PasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

const TotpCodeBody = z.object({ code: z.string().min(6).max(6) });
const TotpDisableBody = z.object({ password: z.string().min(1).max(200) });

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

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/overview", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;

    const settings = app.settings.get();
    const active = getActiveStream(app.db);
    const ingest = await app.mediamtx.getPath(config.ingestPath);
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
        reachable: ingest !== null,
        ready: ingest?.ready ?? false,
        readers: ingest?.readers ?? 0,
        server: ingestServer(settings),
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
    audit(app.db, { userId: session.user.id, username: session.user.username, action: "ingest_key_revealed", ip: req.ip });
    if (!url) return reply.code(503).send({ error: "publish_pass_not_configured" });
    return {
      server: url,
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
          inputUrl: mediaInputUrl(),
          outDir: hlsDir(slug),
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

  app.post("/api/admin/totp/setup", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const secret = generateTotpSecret();
    setTotpSecret(app.db, session.user.id, secret, false);
    audit(app.db, { userId: session.user.id, username: session.user.username, action: "totp_setup", ip: req.ip });
    return { secret, otpauthUrl: otpauthUrl("NDX Live", session.user.username, secret) };
  });

  app.post("/api/admin/totp/enable", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const parsed = safeParse(TotpCodeBody, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request" });
    const user = getUserByUsername(app.db, session.user.username);
    if (!user?.totpSecret) return reply.code(400).send({ error: "totp_not_setup" });
    if (!verifyTotp(user.totpSecret, parsed.data.code)) {
      return reply.code(401).send({ error: "invalid_code" });
    }
    setTotpSecret(app.db, user.id, user.totpSecret, true);
    audit(app.db, { userId: user.id, username: user.username, action: "totp_enabled", ip: req.ip });
    return { ok: true };
  });

  app.post("/api/admin/totp/disable", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const parsed = safeParse(TotpDisableBody, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request" });
    const user = getUserByUsername(app.db, session.user.username);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
      return reply.code(403).send({ error: "invalid_credentials" });
    }
    setTotpSecret(app.db, user.id, null, false);
    audit(app.db, { userId: user.id, username: user.username, action: "totp_disabled", ip: req.ip });
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
