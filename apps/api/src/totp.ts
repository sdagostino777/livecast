/**
 * TOTP (RFC 6238) — six digits, 30-second step, SHA-1.
 *
 * Implemented directly on node:crypto instead of pulling a dependency: the
 * algorithm is ~40 lines and every line of it decides whether the admin account
 * is protected. A library is only worth it when the thing it hides is larger
 * than the thing it adds.
 */
import { createHmac, randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 character");
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBuf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

export function totpAt(secretBase32: string, epochSeconds: number, step = 30, digits = 6): string {
  return hotp(base32Decode(secretBase32), Math.floor(epochSeconds / step), digits);
}

/**
 * Checks a user-supplied code against the current step and one step on each
 * side, which tolerates ordinary clock drift without widening the window to
 * something an attacker can usefully brute-force (a 4-digit code with a ±1
 * window at 6 digits is still ~1/333k per guess per 90 seconds).
 */
export function verifyTotp(secretBase32: string, code: string, nowMs = Date.now(), step = 30, digits = 6, skew = 1): boolean {
  if (!/^\d{6}$/.test(code.trim())) return false;
  const counter = Math.floor(nowMs / 1000 / step);
  const secret = base32Decode(secretBase32);
  for (let d = -skew; d <= skew; d++) {
    if (hotp(secret, counter + d, digits) === code.trim()) return true;
  }
  return false;
}

export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
