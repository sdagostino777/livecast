/**
 * Identifier helpers.
 *
 * The stream slug is the one identifier a stranger sees, so it is random and
 * long enough to be unguessable, while staying lowercase and URL-friendly so
 * it survives being pasted into chat apps and printed on paper.
 */
import { randomBytes } from "node:crypto";

const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/1/l/o ambiguity
export const SLUG_LENGTH = 10;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function newSlug(): string {
  const bytes = randomBytes(SLUG_LENGTH);
  let out = "";
  for (let i = 0; i < SLUG_LENGTH; i++) {
    out += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return out;
}

export function isSlug(value: string): boolean {
  return new RegExp(`^[a-z0-9]{${SLUG_LENGTH}}$`).test(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}
