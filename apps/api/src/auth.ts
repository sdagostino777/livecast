/**
 * Authentication: passwords, sessions, and the admin/operator roles.
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
export const SESSION_COOKIE = "livecast_sid";

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
  mustChangePassword: boolean;
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

export function getUserByUsername(db: Db, username: string): (User & { passwordHash: string }) | null {
  const row = db
    .prepare(`SELECT id, username, role, password_hash, must_change_password FROM users WHERE username_key = ?`)
    .get(username.trim().toLowerCase()) as
    | { id: string; username: string; role: string; password_hash: string; must_change_password: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    passwordHash: row.password_hash,
  };
}

export function listUsers(db: Db): Array<User & { createdAt: string }> {
  const rows = db
    .prepare(`SELECT id, username, role, must_change_password, created_at FROM users ORDER BY created_at ASC`)
    .all() as Array<{ id: string; username: string; role: string; must_change_password: number; created_at: string }>;
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    mustChangePassword: r.must_change_password === 1,
    createdAt: r.created_at,
  }));
}

export function deleteUser(db: Db, id: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

export function createUser(
  db: Db,
  username: string,
  passwordHash: string,
  role = "admin",
  mustChangePassword = false,
): User {
  const id = newId("usr");
  db.prepare(
    `INSERT INTO users (id, username, username_key, password_hash, role, must_change_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, username.trim(), username.trim().toLowerCase(), passwordHash, role, mustChangePassword ? 1 : 0, nowIso());
  return { id, username: username.trim(), role, mustChangePassword };
}

export function setMustChangePassword(db: Db, userId: string, mustChange: boolean): void {
  db.prepare("UPDATE users SET must_change_password = ? WHERE id = ?").run(mustChange ? 1 : 0, userId);
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
      `SELECT s.id, s.expires_at, u.id AS uid, u.username, u.role, u.must_change_password
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as
    | { id: string; expires_at: string; uid: string; username: string; role: string; must_change_password: number }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    return null;
  }
  return {
    sessionId: row.id,
    user: { id: row.uid, username: row.username, role: row.role, mustChangePassword: row.must_change_password === 1 },
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

export const RECOVERY_CODE_COUNT = 8;

/** Recovery codes are shown once and stored only as SHA-256 hashes. */
export function generateRecoveryCodes(db: Db, userId: string): string[] {
  db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
  const insert = db.prepare("INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)");
  const codes: string[] = [];
  const now = nowIso();
  const tx = db.transaction(() => {
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      // 10 base32 characters ≈ 50 bits: long enough to resist guessing even
      // without a rate limit, short enough to copy by hand from paper.
      const raw = randomBytes(8).toString("hex").toUpperCase().slice(0, 10);
      codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
      insert.run(userId, sha256(raw), now);
    }
  });
  tx();
  return codes;
}

/** Consumes a code: true once, false if unknown or already used. */
export function consumeRecoveryCode(db: Db, userId: string, code: string): boolean {
  const normalized = code.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (normalized.length !== 10) return false;
  const row = db
    .prepare("SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
    .get(userId, sha256(normalized)) as { id: number } | undefined;
  if (!row) return false;
  db.prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ?").run(nowIso(), row.id);
  return true;
}

export function countUnusedRecoveryCodes(db: Db, userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .get(userId) as { n: number };
  return row.n;
}

export function setPassword(db: Db, userId: string, passwordHash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}

