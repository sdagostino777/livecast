/**
 * Admin authentication: passwords, sessions, and TOTP.
 *
 * Threat model: the only account is the broadcaster's. If it is taken over, a
 * stranger can push video into the public stream — so password storage is
 * argon2id with OWASP-recommended parameters, sessions are opaque random tokens
 * (never JWTs: revocation must be immediate), and only their SHA-256 is stored,
 * so a database leak does not hand over live sessions.
 */
import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { addHours, newId, nowIso } from "./ids.js";

export const MIN_PASSWORD_LENGTH = 12;

/** The session cookie. Named so it never collides with the fleet app's cookies. */
export const SESSION_COOKIE = "ndx_live_sid";

export function sessionCookieOptions() {
  return {
    path: "/",
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600,
  };
}

const ARGON2 = {
  memoryCost: 19456, // 19 MiB — OWASP argon2id recommendation
  timeCost: 2,
  parallelism: 1,
} as const;

export interface User {
  id: string;
  username: string;
  role: string;
  totpEnabled: boolean;
}

export interface Session {
  sessionId: string;
  user: User;
  expiresAt: string;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function getUserByUsername(db: Db, username: string): (User & { passwordHash: string; totpSecret: string | null }) | null {
  const row = db
    .prepare(
      `SELECT id, username, role, totp_enabled, password_hash, totp_secret
         FROM users WHERE username_key = ?`,
    )
    .get(username.trim().toLowerCase()) as
    | { id: string; username: string; role: string; totp_enabled: number; password_hash: string; totp_secret: string | null }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    totpEnabled: row.totp_enabled === 1,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
  };
}

export function createUser(db: Db, username: string, passwordHash: string, role = "admin"): User {
  const id = newId("usr");
  db.prepare(
    `INSERT INTO users (id, username, username_key, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, username.trim(), username.trim().toLowerCase(), passwordHash, role, nowIso());
  return { id, username: username.trim(), role, totpEnabled: false };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSession(db: Db, userId: string, ip: string | null, userAgent: string | null, hours: number): { token: string; sessionId: string } {
  pruneExpiredSessions(db);
  const token = randomBytes(32).toString("base64url");
  const sessionId = newId("ses");
  const now = new Date();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, ip, user_agent, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    sha256(token),
    ip,
    userAgent ? userAgent.slice(0, 300) : null,
    addHours(now, hours).toISOString(),
    now.toISOString(),
  );
  return { token, sessionId };
}

export function lookupSession(db: Db, token: string): Session | null {
  if (!token || token.length < 20) return null;
  const row = db
    .prepare(
      `SELECT s.id, s.expires_at, u.id AS uid, u.username, u.role, u.totp_enabled
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as
    | { id: string; expires_at: string; uid: string; username: string; role: string; totp_enabled: number }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    return null;
  }
  return {
    sessionId: row.id,
    user: { id: row.uid, username: row.username, role: row.role, totpEnabled: row.totp_enabled === 1 },
    expiresAt: row.expires_at,
  };
}

export function destroySession(db: Db, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function destroyOtherSessions(db: Db, userId: string, keepSessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").run(userId, keepSessionId);
}

export function destroyAllSessions(db: Db, userId: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function pruneExpiredSessions(db: Db): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
}

export function setPassword(db: Db, userId: string, passwordHash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}

export function setTotpSecret(db: Db, userId: string, secret: string | null, enabled: boolean): void {
  db.prepare("UPDATE users SET totp_secret = ?, totp_enabled = ? WHERE id = ?").run(secret, enabled ? 1 : 0, userId);
}
