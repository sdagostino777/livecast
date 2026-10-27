/**
 * SQLite storage.
 *
 * One file, WAL mode, synchronous API (better-sqlite3). At this scale — one
 * broadcaster, a handful of streams, a few sessions — SQLite is strictly better
 * than a database server: no extra process to keep alive on the VPS, no
 * connection pool, and a backup is `cp`. It also makes the tests hermetic.
 *
 * The schema is created idempotently at startup. There is no migration runner
 * yet because there is no earlier schema to migrate from; the first time a
 * column changes, add a `schema_version` table and a switch on it.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export function openDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL,
      username_key  TEXT NOT NULL UNIQUE,          -- lowercase, used for lookups
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,             -- sha256 of the cookie value
      ip         TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS streams (
      id         TEXT PRIMARY KEY,
      slug       TEXT NOT NULL UNIQUE,
      title      TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'draft',    -- draft | starting | live | ended
      kind       TEXT NOT NULL DEFAULT 'video',    -- video | audio
      record     INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      started_at TEXT,
      ended_at   TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status);
    -- At most one stream can be live or starting at a time: there is one ingest path.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_streams_one_active
      ON streams(status) WHERE status IN ('starting', 'live');

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT,
      username   TEXT,
      action     TEXT NOT NULL,
      detail     TEXT,
      ip         TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

    -- Runtime configuration edited from the admin panel (CDN, base URLs, ingest
    -- host/port). Seeded from env on first boot by SettingsStore.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Additive migration for installs created before the audio-only mode existed:
  // SQLite cannot add a column with NOT NULL without a default, and this one has
  // a sensible one.
  const streamCols = db.prepare("PRAGMA table_info(streams)").all() as Array<{ name: string }>;
  if (!streamCols.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE streams ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'");
  }

  return db;
}

export function audit(db: Db, entry: {
  userId?: string | null;
  username?: string | null;
  action: string;
  detail?: string | null;
  ip?: string | null;
}): void {
  db.prepare(
    `INSERT INTO audit_log (user_id, username, action, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.userId ?? null,
    entry.username ?? null,
    entry.action,
    entry.detail ?? null,
    entry.ip ?? null,
    new Date().toISOString(),
  );
}
