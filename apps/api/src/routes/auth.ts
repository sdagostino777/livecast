/**
 * Public authentication endpoints: login, logout, "who am I".
 *
 * Login is the one route that can be attacked from the open internet without a
 * session, so it carries its own rate limit (10 attempts / 15 min / IP, on top
 * of the global limit) and always answers the same generic error: a different
 * message for "unknown user" and "wrong password" turns the login form into a
 * username oracle.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { audit } from "../db.js";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getUserByUsername,
  lookupSession,
  sessionCookieOptions,
  verifyPassword,
} from "../auth.js";
import { verifyTotp } from "../totp.js";

const LoginBody = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
  code: z.string().max(10).optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const parsed = LoginBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const { username, password, code } = parsed.data;

      const user = getUserByUsername(app.db, username);
      const passwordOk = user !== null && (await verifyPassword(user.passwordHash, password));
      if (!user || !passwordOk) {
        audit(app.db, { username, action: "login_failed", detail: "bad_credentials", ip: req.ip });
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      if (user.totpEnabled) {
        const totpOk = Boolean(user.totpSecret) && Boolean(code) && verifyTotp(user.totpSecret!, code!);
        if (!totpOk) {
          audit(app.db, { userId: user.id, username, action: "login_failed", detail: "bad_totp", ip: req.ip });
          return reply.code(401).send({ error: "invalid_credentials" });
        }
      }

      const { token } = createSession(
        app.db,
        user.id,
        req.ip,
        (req.headers["user-agent"] as string | undefined) ?? null,
        config.sessionHours,
      );
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
      audit(app.db, { userId: user.id, username, action: "login_ok", ip: req.ip });
      return {
        user: { username: user.username, role: user.role, totpEnabled: user.totpEnabled },
      };
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      destroySession(app.db, token);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      audit(app.db, { action: "logout", ip: req.ip });
    }
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: "unauthorized" });
    // Re-resolve from the database rather than trusting the cookie: a revoked
    // session must stop working immediately, not at next cookie expiry.
    const session = lookupSession(app.db, token);
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    return { user: { username: session.user.username, role: session.user.role, totpEnabled: session.user.totpEnabled } };
  });
}
