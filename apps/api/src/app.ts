/**
 * Application assembly.
 *
 * `buildApp` is a factory rather than a module with side effects, because the
 * tests need a fresh server per test: same routes, different SQLite file and no
 * listening socket. Production's `main.ts` is a thin `listen` on top of it.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { config, dbFile } from "./config.js";
import { openDb, type Db } from "./db.js";
import { HlsPipeline, type PipelineApi } from "./services/pipeline.js";
import { MediaMtxClient } from "./services/mediamtx.js";
import { SettingsStore, type RuntimeSettings } from "./settings.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { liveRoutes } from "./routes/live.js";
import { reconcileOrphans } from "./streams.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    pipeline: PipelineApi;
    mediamtx: MediaMtxClient;
    settings: SettingsStore;
  }
}

export interface BuildAppOptions {
  db?: Db;
  dbFile?: string;
  webRoot?: string;
  logger?: boolean;
  /** Test seam: replaces the FFmpeg supervisor with a double. */
  pipeline?: PipelineApi;
  mediamtx?: MediaMtxClient;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: "info" } : false,
    // nginx terminates TLS on the same host and sets X-Forwarded-For; trusting
    // only loopback means req.ip reads what nginx saw, not what a client claims.
    trustProxy: "127.0.0.1",
    bodyLimit: 64 * 1024,
  });

  app.decorate("db", opts.db ?? openDb(opts.dbFile ?? dbFile()));
  app.decorate("pipeline", opts.pipeline ?? new HlsPipeline());
  app.decorate("mediamtx", opts.mediamtx ?? new MediaMtxClient(config.mediamtxApiUrl));
  app.decorate("settings", new SettingsStore(app.db));

  // The encoder supervisor is memory, not database. After a restart, any stream
  // still marked starting/live is a row without a process — end it now rather
  // than let it block the next broadcast through the one-active-stream index.
  const orphans = reconcileOrphans(app.db);
  if (orphans > 0) app.log.warn({ orphans }, "ended orphaned streams left by a previous process");

  // Image uploads arrive as raw bytes (`fetch(url, { body: file })`), not as
  // multipart: one fewer dependency, and the panel controls what is sent.
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute", keyGenerator: (req) => req.ip });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; " +
        "base-uri 'none'; form-action 'self'",
    );
  });

  // CSRF defence in depth: session cookies are SameSite=Lax (cross-site POSTs
  // never carry them), and any mutating request that does carry an Origin must
  // come from the configured public origin. Read at request time: the operator
  // can change the base URL from the panel without a restart.
  app.addHook("preValidation", async (req, reply) => {
    if (!MUTATING_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = new URL(app.settings.get().publicBaseUrl).origin;
    if (origin !== allowed) {
      return reply.code(403).send({ error: "origin_not_allowed" });
    }
  });

  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  // Public branding: the login page and the player need the name before there
  // is a session, and it is not a secret.
  app.get("/api/brand", async () => ({ name: app.settings.get().brandName }));

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(liveRoutes);

  // HLS from the API process is a development convenience only: in production
  // nginx serves /hls/ straight from disk with cache headers, without involving
  // Node at all. Registering it here costs one conditional.
  const uploadsRoot = path.join(config.dataDir, "uploads");
  fs.mkdirSync(uploadsRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: uploadsRoot,
    prefix: "/uploads/",
    decorateReply: false,
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=3600");
    },
  });

  const hlsRoot = path.join(config.dataDir, "hls");
  if (fs.existsSync(hlsRoot)) {
    await app.register(fastifyStatic, {
      root: hlsRoot,
      prefix: "/hls/",
      wildcard: true,
      decorateReply: false,
      // When a CDN is configured, the player on the origin domain fetches
      // manifests and segments from the CDN host — a cross-origin request that
      // hls.js makes with fetch/XHR and the browser blocks without CORS. The
      // content is public, so a wildcard origin is the correct answer here; it
      // is set at the origin too so any CDN that passes headers through keeps
      // working even if its own CORS switch is off.
      setHeaders(res, filePath) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        // Mirror the production nginx cache policy so a request served by the
        // app (development, or the HTTP bootstrap before TLS) behaves the same.
        if (filePath.endsWith(".ts")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (filePath.endsWith(".m3u8")) {
          res.setHeader("Cache-Control", "no-store");
        }
      },
    });
  }

  const webRoot = opts.webRoot ?? config.webRoot;
  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      // No wildcard route: the not-found handler below decides between "this is
      // a file" and "this is an SPA route". A wildcard static route serves
      // index.html for real asset paths only by accident.
      wildcard: false,
      decorateReply: true,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return reply.code(404).send({ error: "not_found" });
      }
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      const pathname = (req.url.split("?")[0] ?? "/").replace(/^\/+/, "");
      if (pathname === "") return reply.sendFile("index.html");
      const candidate = path.join(webRoot, pathname);
      // `reply.sendFile` resolves on missing files by sending a 404, not by
      // rejecting, so existence is checked here: that is the difference between
      // a missing asset and an SPA route.
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return reply.sendFile(pathname);
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "not_found" }));
  }

  // The viewer page is public but must not be indexed: it is shared as a link,
  // and a search engine result pointing at a live event is a different audience.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/live/")) reply.header("X-Robots-Tag", "noindex, nofollow");
    return payload;
  });

  return app;
}
