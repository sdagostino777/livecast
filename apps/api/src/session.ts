/**
 * Request-level session helpers shared by the admin routes.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";
import { SESSION_COOKIE, lookupSession, type Session } from "./auth.js";

export function sessionFromRequest(db: Db, req: FastifyRequest): Session | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  return lookupSession(db, token);
}

/**
 * Returns the session, or sends 401 and returns null. Routes are written as
 * `const s = requireSession(...); if (!s) return reply;` so a forgotten auth
 * check cannot silently become a public endpoint.
 */
export function requireSession(db: Db, req: FastifyRequest, reply: FastifyReply): Session | null {
  const session = sessionFromRequest(db, req);
  if (!session) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return session;
}
