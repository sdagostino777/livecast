/**
 * Stream records: the repository half of the app.
 *
 * Kept out of the route files so that "what is the active stream" is answered
 * in exactly one place — three routes need it (overview, start, stop) and they
 * must never disagree.
 */
import type { Db } from "./db.js";
import { newId, newSlug, nowIso } from "./ids.js";

export type StreamStatus = "draft" | "starting" | "live" | "ended";

export interface StreamRow {
  id: string;
  slug: string;
  title: string;
  status: StreamStatus;
  record: number;
  created_by: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface StreamView {
  id: string;
  slug: string;
  title: string;
  status: StreamStatus;
  record: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  pageUrl: string;
}

export function toView(row: StreamRow, publicBaseUrl: string = process.env.PUBLIC_URL ?? ""): StreamView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    record: row.record === 1,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    pageUrl: `${publicBaseUrl.replace(/\/+$/, "")}/live/${row.slug}`,
  };
}

export function getStreamById(db: Db, id: string): StreamRow | null {
  return (db.prepare("SELECT * FROM streams WHERE id = ?").get(id) as StreamRow | undefined) ?? null;
}

export function getStreamBySlug(db: Db, slug: string): StreamRow | null {
  return (db.prepare("SELECT * FROM streams WHERE slug = ?").get(slug) as StreamRow | undefined) ?? null;
}

export function getActiveStream(db: Db): StreamRow | null {
  return (
    (db.prepare("SELECT * FROM streams WHERE status IN ('starting','live') LIMIT 1").get() as
      | StreamRow
      | undefined) ?? null
  );
}

export function listStreams(db: Db, limit = 50): StreamRow[] {
  return db.prepare("SELECT * FROM streams ORDER BY created_at DESC LIMIT ?").all(limit) as StreamRow[];
}

export function createStreamRow(db: Db, opts: { title: string; record: boolean; createdBy: string | null }): StreamRow {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = newId("str");
    const slug = newSlug();
    try {
      db.prepare(
        `INSERT INTO streams (id, slug, title, status, record, created_by, created_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
      ).run(id, slug, opts.title, opts.record ? 1 : 0, opts.createdBy, nowIso());
      return getStreamById(db, id)!;
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code.startsWith("SQLITE_CONSTRAINT") && attempt < 7) continue; // slug collision: regenerate
      throw err;
    }
  }
  throw new Error("could not allocate a unique slug");
}

export function setStreamStatus(db: Db, id: string, status: StreamStatus, at: string | null = null): void {
  db.prepare("UPDATE streams SET status = ? WHERE id = ?").run(status, id);
  if (status === "live" || status === "starting") {
    db.prepare("UPDATE streams SET started_at = COALESCE(started_at, ?), ended_at = NULL WHERE id = ?").run(
      at ?? nowIso(),
      id,
    );
  }
  if (status === "ended") {
    db.prepare("UPDATE streams SET ended_at = ? WHERE id = ?").run(at ?? nowIso(), id);
  }
}

export function deleteStreamRow(db: Db, id: string): void {
  db.prepare("DELETE FROM streams WHERE id = ?").run(id);
}
