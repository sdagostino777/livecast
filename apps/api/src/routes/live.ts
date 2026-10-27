/**
 * Public viewer API.
 *
 * No PIN and no session: the link is the access control, by decision. What this
 * route still does is refuse to reveal a draft stream — a draft exists before
 * anyone speaks to anyone, and its slug should not be a valid URL until the
 * broadcaster has created a real event.
 *
 * `hlsUrl` is absolute and points at the CDN when one is configured, so the
 * player code never needs to know where delivery happens.
 */
import type { FastifyInstance } from "fastify";
import { isSlug } from "../ids.js";
import { getStreamBySlug, toView } from "../streams.js";

export async function liveRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/live/:slug", async (req, reply) => {
    const { slug } = req.params as { slug?: string };
    if (!slug || !isSlug(slug)) return reply.code(404).send({ error: "not_found" });

    const row = getStreamBySlug(app.db, slug);
    if (!row || row.status === "draft") return reply.code(404).send({ error: "not_found" });

    const settings = app.settings.get();
    const view = toView(row, settings.publicBaseUrl);
    return { ...view, hlsUrl: `${app.settings.hlsBaseUrl()}/hls/${row.slug}/master.m3u8` };
  });
}
