/**
 * Public viewer API.
 *
 * No PIN and no session: the link is the access control, by decision. The link
 * has to work before the broadcast starts — people open it early and must see
 * the event name and poster while they wait — so every state answers.
 *
 * `hlsUrl` is absolute and points at the CDN when one is configured, so the
 * player code never needs to know where delivery happens.
 */
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { z } from "zod";

import path from "node:path";

import { artworkFor } from "../artwork.js";
import { uploadsDir } from "../config.js";
import { iconSvg } from "../poster.js";
import { isSlug } from "../ids.js";
import { touchViewer } from "../presence.js";
import { getStreamBySlug, toView } from "../streams.js";

const PresenceBody = z.object({ id: z.string().min(4).max(64) });

export async function liveRoutes(app: FastifyInstance): Promise<void> {
  // The event artwork: the uploaded image (with the title drawn on top when the
  // operator asked for it) or the generated template.
  app.get("/api/poster/:slug", async (req, reply) => {
    const { slug } = req.params as { slug?: string };
    if (!slug || !isSlug(slug)) return reply.code(404).send({ error: "not_found" });
    const row = getStreamBySlug(app.db, slug);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const art = artworkFor(row, app.settings.get().brandName);
    reply.header("cache-control", "public, max-age=60").header("x-robots-tag", "noindex");
    if (art.kind === "file") {
      reply.header("content-type", art.contentType);
      return reply.send(fs.createReadStream(art.file));
    }
    reply.header("content-type", "image/svg+xml; charset=utf-8");
    return art.body;
  });

  // The event icon: the browser tab icon while the page is open, and the badge
  // next to the title before the broadcast starts.
  app.get("/api/icon/:slug", async (req, reply) => {
    const { slug } = req.params as { slug?: string };
    if (!slug || !isSlug(slug)) return reply.code(404).send({ error: "not_found" });
    const row = getStreamBySlug(app.db, slug);
    if (!row) return reply.code(404).send({ error: "not_found" });
    reply.header("cache-control", "public, max-age=300").header("x-robots-tag", "noindex");
    if (row.icon_ext) {
      const file = path.join(uploadsDir(), `${row.slug}.icon.${row.icon_ext}`);
      const type = row.icon_ext === "png" ? "image/png" : row.icon_ext === "webp" ? "image/webp" : "image/jpeg";
      reply.header("content-type", type);
      return reply.send(fs.createReadStream(file));
    }
    reply.header("content-type", "image/svg+xml; charset=utf-8");
    return iconSvg({ title: row.title, seed: row.slug, palette: row.poster_palette });
  });

  // Heartbeat from an open player page: the panel shows how many people are
  // connected. Public because watching is public; no history is kept.
  app.post("/api/live/:slug/presence", async (req, reply) => {
    const { slug } = req.params as { slug?: string };
    if (!slug || !isSlug(slug)) return reply.code(404).send({ error: "not_found" });
    const row = getStreamBySlug(app.db, slug);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const parsed = PresenceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    reply.header("cache-control", "no-store");
    return { viewers: touchViewer(row.slug, parsed.data.id) };
  });

  app.get("/api/live/:slug", async (req, reply) => {
    const { slug } = req.params as { slug?: string };
    if (!slug || !isSlug(slug)) return reply.code(404).send({ error: "not_found" });

    const row = getStreamBySlug(app.db, slug);
    if (!row) return reply.code(404).send({ error: "not_found" });

    const settings = app.settings.get();
    const view = toView(row, settings.publicBaseUrl);
    return { ...view, hlsUrl: `${app.settings.hlsBaseUrl()}/hls/${row.slug}/master.m3u8` };
  });
}
