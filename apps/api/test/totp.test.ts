import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, hotp, totpAt, verifyTotp } from "../src/totp.js";

// RFC 6238 test vectors: ASCII secret "12345678901234567890", SHA-1, 8 digits.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP", () => {
  it("matches the RFC 6238 vectors (8 digits)", () => {
    const secret = base32Decode(RFC_SECRET);
    for (const [t, expected] of RFC_VECTORS) {
      const code = hotp(secret, Math.floor(t / 30), 8);
      expect(code, `T=${t}`).toBe(expected);
    }
  });

  it("derives the 6-digit code from the same counter", () => {
    // 6 digits is the 8-digit value truncated mod 10^6 by the same dynamic-truncation rule.
    for (const [t, expected] of RFC_VECTORS) {
      expect(totpAt(RFC_SECRET, t)).toBe(String(Number(expected) % 1_000_000).padStart(6, "0"));
    }
  });

  it("round-trips base32", () => {
    const raw = Buffer.from("NDX Live TOTP secret!");
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
  });

  it("accepts the current code and one step of drift, rejects two steps", () => {
    const secret = generateTotpSecret();
    const nowMs = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, nowMs / 1000), nowMs)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, nowMs / 1000 - 30), nowMs)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, nowMs / 1000 + 30), nowMs)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, nowMs / 1000 - 90), nowMs)).toBe(false);
  });

  it("rejects malformed codes without throwing", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "abcdef")).toBe(false);
    expect(verifyTotp(secret, "12345")).toBe(false);
    expect(verifyTotp(secret, "")).toBe(false);
  });
});
