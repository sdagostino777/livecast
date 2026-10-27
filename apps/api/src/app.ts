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
import { brandLogoExtension, brandLogoFile } from "./brand.js";
import { config, dbFile } from "./config.js";
import { openDb, type Db } from "./db.js";
import { HlsPipeline, type PipelineApi } from "./services/pipeline.js";
import { MediaMtxClient } from "./services/mediamtx.js";
import { SettingsStore, type RuntimeSettings } from "./settings.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { liveRoutes } from "./routes/live.js";
import { imageDimensions } from "./images.js";
import { getStreamBySlug, reconcileOrphans } from "./streams.js";
import { SignalWatchdog } from "./services/watchdog.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    pipeline: PipelineApi;
    mediamtx: MediaMtxClient;
    settings: SettingsStore;
    signalWatchdog: SignalWatchdog;
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

  // A broadcast without a publisher must not survive: the panel would claim
  // "In onda" while viewers stare at a dead player.
  const watchdog = new SignalWatchdog({
    db: app.db,
    pipeline: app.pipeline,
    mediamtx: app.mediamtx,
    primaryPath: config.ingestPath,
    backupPath: config.ingestBackupPath,
  });
  watchdog.start();
  app.decorate("signalWatchdog", watchdog);
  app.addHook("onClose", async () => watchdog.stop());

  // Image uploads arrive as raw bytes (`fetch(url, { body: file })`), not as
  // multipart: one fewer dependency, and the panel controls what is sent.
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 1200, timeWindow: "1 minute", keyGenerator: (req) => req.ip });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      // img-src allows blob: for the upload previews the panel builds with
      // URL.createObjectURL before the file reaches the server.
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; " +
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
  app.get("/api/brand", async () => ({
    name: app.settings.get().brandName,
    logoUrl: brandLogoExtension() ? "/api/brand/logo" : null,
  }));

  // The logo the operator uploaded, if any. Cached briefly: it changes rarely
  // and it is on every page.
  app.get("/api/brand/logo", async (_req, reply) => {
    const logo = brandLogoFile();
    if (!logo) return reply.code(404).send({ error: "not_found" });
    reply.header("content-type", logo.contentType).header("cache-control", "public, max-age=60");
    return reply.send(fs.createReadStream(logo.file));
  });

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
      // cacheControl is disabled so this plugin cannot overwrite the headers
      // below; files served through its own routes get them here, SPA routes
      // get them explicitly in the not-found handler.
      cacheControl: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-store");
        } else if (filePath.includes("/assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "public, max-age=3600");
        }
      },
    });
    /**
     * Link previews are built from the raw HTML: messaging apps never run the
     * JavaScript that would paint the event page. The shared link therefore gets
     * Open Graph tags injected here, with the operator's own name, the event
     * title and an image that WhatsApp can actually display (a generated SVG is
     * not one of those, so the uploaded poster is used when there is one).
     */
    function socialHead(slug: string): string {
      const row = getStreamBySlug(app.db, slug);
      if (!row) return "";
      const settings = app.settings.get();
      const base = settings.publicBaseUrl.replace(/\/+$/, "");
      const escape = (value: string) =>
        value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const title = `${row.title} · ${settings.brandName}`;
      const description = `Diretta di ${settings.brandName}. Apri il link per ascoltare.`;
      // A raster image is required — the generated artwork is an SVG, which these
      // platforms do not render — so the uploaded poster is used when it exists.
      const image = row.poster_ext ? `${base}/uploads/${row.slug}.poster.${row.poster_ext}` : null;
      // Real dimensions, when the file can be read, so the preview is not cropped.
      const imageFile = row.poster_ext
        ? path.join(config.dataDir, "uploads", `${row.slug}.poster.${row.poster_ext}`)
        : null;
      let size: { width: number; height: number } | null = null;
      if (imageFile) {
        try {
          size = imageDimensions(fs.readFileSync(imageFile));
        } catch {
          size = null;
        }
      }
      const tags = [
        `<title>${escape(title)}</title>`,
        `<meta name="description" content="${escape(description)}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="${escape(settings.brandName)}">`,
        `<meta property="og:title" content="${escape(title)}">`,
        `<meta property="og:description" content="${escape(description)}">`,
        `<meta property="og:url" content="${base}/live/${row.slug}">`,
        image ? `<meta property="og:image" content="${escape(image)}">` : "",
        image ? `<meta property="og:image:alt" content="${escape(row.title)}">` : "",
        size ? `<meta property="og:image:width" content="${size.width}">` : "",
        size ? `<meta property="og:image:height" content="${size.height}">` : "",
        `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
        `<meta name="twitter:title" content="${escape(title)}">`,
        `<meta name="twitter:description" content="${escape(description)}">`,
        image ? `<meta name="twitter:image" content="${escape(image)}">` : "",
      ];
      return tags.filter(Boolean).join("\n    ");
    }

    /** The SPA shell with the event's own tags, for crawlers and browsers alike. */
    function shellFor(slug: string | null): string {
      const shell = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
      if (!slug) return shell;
      const head = socialHead(slug);
      if (!head) return shell;
      // The static <title> is replaced, not duplicated.
      const withoutTitle = shell.replace(/<title>[^<]*<\/title>/, "");
      return withoutTitle.replace("</head>", `    ${head}\n  </head>`);
    }

    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return reply.code(404).send({ error: "not_found" });
      }
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      const pathname = (req.url.split("?")[0] ?? "/").replace(/^\/+/, "");
      // index.html names the hashed bundles: caching it means a deploy can be
      // invisible to a browser that already has the old page. Assets are
      // content-addressed and safe to cache forever.
      if (pathname === "" || pathname === "index.html") {
        reply.header("Cache-Control", "no-store");
        return reply.sendFile("index.html");
      }
      const liveMatch = /^live\/([a-z0-9]{10})\/?$/.exec(pathname);
      const candidate = path.join(webRoot, pathname);
      // `reply.sendFile` resolves on missing files by sending a 404, not by
      // rejecting, so existence is checked here: that is the difference between
      // a missing asset and an SPA route.
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        reply.header("Cache-Control", pathname.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600");
        return reply.sendFile(pathname);
      }
      reply.header("Cache-Control", "no-store");
      if (liveMatch?.[1]) {
        reply.header("content-type", "text/html; charset=utf-8");
        return reply.send(shellFor(liveMatch[1]));
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
