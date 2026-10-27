/**
 * How many people are watching, without a database and without accounts.
 *
 * The player posts a heartbeat while the page is open. Counting live listeners
 * is then a filter over recent timestamps, which is cheap, self-cleaning, and
 * cannot drift: a viewer that stops sending simply ages out.
 */
const TTL_MS = 75_000;

const viewers = new Map<string, Map<string, number>>();

/** Record a heartbeat from one open player page. */
export function touchViewer(slug: string, viewerId: string): number {
  const now = Date.now();
  let room = viewers.get(slug);
  if (!room) {
    room = new Map();
    viewers.set(slug, room);
  }
  room.set(viewerId, now);
  for (const [id, seen] of room) {
    if (now - seen > TTL_MS) room.delete(id);
  }
  if (room.size === 0) viewers.delete(slug);
  return room.size;
}

/** Listeners seen in the last TTL window. */
export function countViewers(slug: string): number {
  const room = viewers.get(slug);
  if (!room) return 0;
  const now = Date.now();
  let alive = 0;
  for (const [id, seen] of room) {
    if (now - seen > TTL_MS) room.delete(id);
    else alive += 1;
  }
  if (room.size === 0) viewers.delete(slug);
  return alive;
}

/** Needed by tests and the "reset broadcast" tool: forget everyone. */
export function forgetViewers(slug?: string): void {
  if (slug === undefined) viewers.clear();
  else viewers.delete(slug);
}
