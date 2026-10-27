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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import fs from "node:fs";
import path from "node:path";
import { config, hlsDir, recordingsDir, uploadsDir } from "../config.js";
import { audit } from "../db.js";
import {
  MIN_PASSWORD_LENGTH,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  createUser,
  generateRecoveryCodes,
  setMustChangePassword,
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
import { artworkFor } from "../artwork.js";
import { removeBrandLogo, saveBrandLogo } from "../brand.js";
import { countViewers } from "../presence.js";
import { iconSvg } from "../poster.js";
import { journalLines, recentInMemory, remember } from "../services/logs.js";
import { ingestServer, ingestServerWithCreds, mediaInputUrl, mediaRtspInputUrl } from "../ingest.js";

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
  posterOverlay: z.boolean().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(["video", "audio"]).optional(),
  record: z.boolean().optional(),
  posterPalette: z.enum(["blue", "teal", "indigo", "slate", "plum"]).nullable().optional(),
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

/** Returns the extension for the three formats the panel accepts, or null. */
function imageExtension(buf: Buffer): "jpg" | "png" | "webp" | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
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
  // A default password ("Admin") must be changed before anything else in the
  // panel works: the account that can push video to the public stream is not
  // allowed to keep a password that is printed in the docs.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/admin/")) return;
    if (req.url.startsWith("/api/admin/password")) return;
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    if (session.user.mustChangePassword) {
      return reply.code(403).send({ error: "password_change_required" });
    }
  });
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
      viewers: active ? countViewers(active.slug) : 0,
      pipeline: {
        status: app.pipeline.status,
        attempts: app.pipeline.attempts(),
        startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
        lastError: app.pipeline.lastExit?.stderrTail ? app.pipeline.lastExit.stderrTail.slice(-600) : null,
        caps: app.pipeline.caps(),
        lastInput: (app.pipeline as unknown as { lastInputUrl?: string | null }).lastInputUrl ?? null,
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
    // One install = one broadcast: creating a new one replaces the previous
    // configuration (and its images) instead of piling up a list.
    const existing = app.db.prepare("SELECT id, slug, status FROM streams").all() as Array<{ id: string; slug: string; status: string }>;
    if (existing.some((row) => row.status === "starting" || row.status === "live")) {
      return reply.code(409).send({ error: "stream_active" });
    }
    for (const old of existing) {
      for (const kind of ["poster", "icon"] as const) {
        for (const ext of ["jpg", "png", "webp"]) {
          try {
            fs.unlinkSync(path.join(uploadsDir(), `${old.slug}.${kind}.${ext}`));
          } catch {
            /* not present */
          }
        }
      }
      deleteStreamRow(app.db, old.id);
    }
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
    // Once a broadcast is on air its identity is frozen: the title and the
    // artwork are what the audience is looking at, and editors flipping them
    // mid-transmission is how a live event ends up mislabelled. Editing is
    // allowed while it is a draft or after it ended.
    const onAir = stream.status === "starting" || stream.status === "live";
    if (onAir && body.data.title !== undefined) {
      return reply.code(409).send({ error: "stream_on_air" });
    }
    if (onAir && body.data.posterPalette !== undefined) {
      return reply.code(409).send({ error: "stream_on_air" });
    }
    if (onAir && body.data.posterOverlay !== undefined) {
      return reply.code(409).send({ error: "stream_on_air" });
    }
    // Kind and recording shape the encoder, so they are editable while the
    // broadcast is idle (draft or ended) and frozen once it is on air.
    if (onAir && body.data.kind !== undefined) {
      return reply.code(409).send({ error: "stream_on_air" });
    }
    if (body.data.title !== undefined) {
      app.db.prepare("UPDATE streams SET title = ? WHERE id = ?").run(body.data.title, stream.id);
    }
    if (body.data.kind !== undefined) {
      app.db.prepare("UPDATE streams SET kind = ? WHERE id = ?").run(body.data.kind, stream.id);
    }
    if (body.data.record !== undefined) {
      app.db.prepare("UPDATE streams SET record = ? WHERE id = ?").run(body.data.record ? 1 : 0, stream.id);
    }
    if (body.data.posterPalette !== undefined) {
      app.db.prepare("UPDATE streams SET poster_palette = ? WHERE id = ?").run(body.data.posterPalette, stream.id);
    }
    if (body.data.posterOverlay !== undefined) {
      app.db.prepare("UPDATE streams SET poster_overlay = ? WHERE id = ?").run(body.data.posterOverlay ? 1 : 0, stream.id);
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
    // The event images belong to the stream: removing the row must not leave
    // files behind in DATA_DIR/uploads.
    for (const kind of ["poster", "icon"] as const) {
      for (const ext of ["jpg", "png", "webp"]) {
        try {
          fs.unlinkSync(path.join(uploadsDir(), `${stream.slug}.${kind}.${ext}`));
        } catch {
          /* not present */
        }
      }
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
          // RTSP first: it reads streams published by the browser (WebRTC) as
          // well as by external programs (RTMP). RTMP is the fallback.
          inputUrls: {
            primary: mediaRtspInputUrl(config.ingestPath),
            backup: mediaRtspInputUrl(config.ingestBackupPath),
            fallbackPrimary: mediaInputUrl(config.ingestPath),
            fallbackBackup: mediaInputUrl(config.ingestBackupPath),
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
          onLog: (line) => {
            // Encoder stderr is the only window into a stuck broadcast: errors
            // must reach the journal and the panel, not disappear at debug level.
            remember(`[${slug}] ${line}`);
            if (/error|failed|invalid|timed out|unable/i.test(line)) app.log.warn({ slug, line: line.slice(0, 300) });
            else app.log.debug({ slug, line });
          },
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
    setMustChangePassword(app.db, user.id, false);
    destroyOtherSessions(app.db, user.id, session.sessionId);
    // A new password regenerates the recovery codes: old printouts must stop
    // working the moment the password they protected changes.
    const recoveryCodes = generateRecoveryCodes(app.db, user.id);
    audit(app.db, { userId: user.id, username: user.username, action: "password_changed", ip: req.ip });
    return { ok: true, recoveryCodes };
  });

  // --- generated artwork (used when no image was uploaded) ------------------

  app.get("/api/admin/poster/:id", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const params = safeParse(IdParams, req.params);
    if (!params.ok) return reply.code(400).send({ error: "invalid_request" });
    const stream = getStreamById(app.db, params.data.id);
    if (!stream) return reply.code(404).send({ error: "not_found" });
    // no-store: this artwork is rendered from the title and palette the operator
    // is editing right now; a cached copy made the preview look frozen.
    const art = artworkFor(stream, app.settings.get().brandName);
    if (art.kind === "file") {
      reply.header("content-type", art.contentType).header("cache-control", "no-store");
      return reply.send(fs.createReadStream(art.file));
    }
    reply.header("content-type", "image/svg+xml; charset=utf-8").header("cache-control", "no-store");
    return art.body;
  });

  app.get("/api/admin/icon/:id", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const params = safeParse(IdParams, req.params);
    if (!params.ok) return reply.code(400).send({ error: "invalid_request" });
    const stream = getStreamById(app.db, params.data.id);
    if (!stream) return reply.code(404).send({ error: "not_found" });
    reply.header("cache-control", "no-store");
    if (stream.icon_ext) {
      const file = path.join(uploadsDir(), `${stream.slug}.icon.${stream.icon_ext}`);
      const type = stream.icon_ext === "png" ? "image/png" : stream.icon_ext === "webp" ? "image/webp" : "image/jpeg";
      reply.header("content-type", type);
      return reply.send(fs.createReadStream(file));
    }
    reply.header("content-type", "image/svg+xml; charset=utf-8");
    return iconSvg({ title: stream.title, seed: stream.slug, palette: stream.poster_palette });
  });

  // --- event images (poster before playback, square icon in lists) ----------
  async function uploadImage(req: FastifyRequest, reply: FastifyReply, kind: "poster" | "icon") {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const params = safeParse(IdParams, req.params);
    if (!params.ok) return reply.code(400).send({ error: "invalid_request" });
    const stream = getStreamById(app.db, params.data.id);
    if (!stream) return reply.code(404).send({ error: "not_found" });
    if (stream.status === "starting" || stream.status === "live") {
      return reply.code(409).send({ error: "stream_on_air" });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: "expected_image_bytes" });
    if (body.length > 6 * 1024 * 1024) return reply.code(413).send({ error: "image_too_large" });
    const ext = imageExtension(body);
    if (!ext) return reply.code(400).send({ error: "unsupported_image_format" });

    const dir = uploadsDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const old of ["jpg", "png", "webp"]) {
      if (old !== ext) {
        try {
          fs.unlinkSync(path.join(dir, `${stream.slug}.${kind}.${old}`));
        } catch {
          /* not present */
        }
      }
    }
    fs.writeFileSync(path.join(dir, `${stream.slug}.${kind}.${ext}`), body);
    app.db.prepare(`UPDATE streams SET ${kind}_ext = ? WHERE id = ?`).run(ext, stream.id);
    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: `${kind}_uploaded`,
      detail: `${stream.slug}.${ext}`,
      ip: req.ip,
    });
    return { stream: toView(getStreamById(app.db, stream.id)!, app.settings.get().publicBaseUrl) };
  }

  // --- the install's own identity (name is in settings, logo is a file) ------
  app.post("/api/admin/brand/logo", { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    if (session.user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: "expected_image_bytes" });
    const ext = imageExtension(body);
    if (!ext) return reply.code(400).send({ error: "unsupported_image_format" });
    saveBrandLogo(body, ext);
    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "brand_logo_uploaded",
      detail: ext,
      ip: req.ip,
    });
    return { logoUrl: "/api/brand/logo" };
  });

  app.delete("/api/admin/brand/logo", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    if (session.user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    removeBrandLogo();
    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "brand_logo_removed",
      ip: req.ip,
    });
    return { logoUrl: null };
  });

  app.post("/api/admin/streams/:id/poster", { bodyLimit: 6 * 1024 * 1024 }, (req, reply) =>
    uploadImage(req, reply, "poster"),
  );
  app.post("/api/admin/streams/:id/icon", { bodyLimit: 6 * 1024 * 1024 }, (req, reply) =>
    uploadImage(req, reply, "icon"),
  );

  for (const kind of ["poster", "icon"] as const) {
    app.delete(`/api/admin/streams/:id/${kind}`, async (req, reply) => {
      const session = requireSession(app.db, req, reply);
      if (!session) return reply;
      const params = safeParse(IdParams, req.params);
      if (!params.ok) return reply.code(400).send({ error: "invalid_request" });
      const stream = getStreamById(app.db, params.data.id);
      if (!stream) return reply.code(404).send({ error: "not_found" });
      if (stream.status === "starting" || stream.status === "live") {
        return reply.code(409).send({ error: "stream_on_air" });
      }
      const ext = kind === "poster" ? stream.poster_ext : stream.icon_ext;
      if (ext) {
        try {
          fs.unlinkSync(path.join(uploadsDir(), `${stream.slug}.${kind}.${ext}`));
        } catch {
          /* already gone */
        }
      }
      app.db.prepare(`UPDATE streams SET ${kind}_ext = NULL WHERE id = ?`).run(stream.id);
      audit(app.db, {
        userId: session.user.id,
        username: session.user.username,
        action: `${kind}_removed`,
        detail: stream.slug,
        ip: req.ip,
      });
      return { stream: toView(getStreamById(app.db, stream.id)!, app.settings.get().publicBaseUrl) };
    });
  }

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

  // --- recovery codes ------------------------------------------------------
  // Printed once, stored as hashes, usable from the login page without a
  // session. Regenerating requires the current password.

  app.get("/api/admin/recovery-codes", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    return { remaining: countUnusedRecoveryCodes(app.db, session.user.id) };
  });

  app.post("/api/admin/recovery-codes", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const parsed = safeParse(z.object({ password: z.string().min(1).max(200) }), req.body);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid_request" });
    const user = getUserByUsername(app.db, session.user.username);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
      return reply.code(403).send({ error: "invalid_credentials" });
    }
    const codes = generateRecoveryCodes(app.db, user.id);
    audit(app.db, { userId: user.id, username: user.username, action: "recovery_codes_generated", ip: req.ip });
    return { recoveryCodes: codes };
  });

  // --- logs ---------------------------------------------------------------
  app.get("/api/admin/logs", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const limit = Math.min(Math.max(Number((req.query as { lines?: string }).lines ?? 200) || 200, 20), 1000);
    const unit = process.env.APP_UNIT || "livecast.service";
    const fromJournal = await journalLines(unit, limit);
    const memory = recentInMemory(limit);
    return {
      source: fromJournal ? `journalctl -u ${unit}` : "memoria del processo",
      lines: fromJournal ?? memory,
      memory,
    };
  });

  // --- kill whatever is left hanging -------------------------------------
  app.post("/api/admin/broadcast/reset", async (req, reply) => {
    const session = requireSession(app.db, req, reply);
    if (!session) return reply;
    const cleaned: string[] = [];

    const active = getActiveStream(app.db);
    try {
      app.pipeline.stop();
    } catch {
      /* nothing to stop */
    }
    if (active) {
      setStreamStatus(app.db, active.id, "ended");
      cleaned.push(`diretta "${active.slug}" chiusa`);
    }

    // Any stream left active in the database, and its segments, goes too.
    const leftovers = app.db.prepare("SELECT id, slug FROM streams WHERE status IN ('starting','live')").all() as Array<{
      id: string;
      slug: string;
    }>;
    for (const row of leftovers) {
      setStreamStatus(app.db, row.id, "ended");
      cleaned.push(`stato di ${row.slug} corretto`);
    }

    const hlsRoot = path.join(config.dataDir, "hls");
    try {
      for (const entry of fs.readdirSync(hlsRoot)) {
        fs.rmSync(path.join(hlsRoot, entry), { recursive: true, force: true });
        cleaned.push(`segmenti di ${entry} rimossi`);
      }
    } catch {
      /* nothing to clean */
    }

    audit(app.db, {
      userId: session.user.id,
      username: session.user.username,
      action: "broadcast_reset",
      detail: cleaned.join(" · ") || "niente da fare",
      ip: req.ip,
    });
    return { cleaned };
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
