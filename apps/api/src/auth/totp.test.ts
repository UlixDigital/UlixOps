import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  timeStep,
  totpAt,
  verifyTotp,
} from "./totp";

// RFC 6238 appendix B (SHA-1). The RFC lists 8-digit codes; 6-digit codes are their last 6 digits.
const RFC_KEY = Buffer.from("12345678901234567890");
const RFC_VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("totp", () => {
  it.each(RFC_VECTORS)("matches RFC 6238 at t=%i", (seconds, code) => {
    expect(totpAt(RFC_KEY, timeStep(new Date(seconds * 1000)))).toBe(code);
  });

  it("round-trips base32", () => {
    const bytes = Buffer.from("12345678901234567890");
    expect(base32Encode(bytes)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(() => base32Decode("NOT-BASE32!")).toThrow();
  });

  it("generates 160-bit secrets", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  describe("verifyTotp", () => {
    const secret = base32Encode(RFC_KEY);
    const at = new Date(1111111111 * 1000);
    const step = timeStep(at);

    it("accepts the current step and one step of drift either side", () => {
      expect(verifyTotp(secret, totpAt(RFC_KEY, step), at, null)).toBe(step);
      expect(verifyTotp(secret, totpAt(RFC_KEY, step - 1), at, null)).toBe(step - 1);
      expect(verifyTotp(secret, totpAt(RFC_KEY, step + 1), at, null)).toBe(step + 1);
      expect(verifyTotp(secret, totpAt(RFC_KEY, step - 2), at, null)).toBeNull();
    });

    it("never accepts a step that was already used (replay)", () => {
      const code = totpAt(RFC_KEY, step);
      expect(verifyTotp(secret, code, at, step)).toBeNull();
      expect(verifyTotp(secret, totpAt(RFC_KEY, step + 1), at, step)).toBe(step + 1);
    });

    it.each(["", "12345", "1234567", "abcdef", "12 456"])("rejects malformed code %j", (code) => {
      expect(verifyTotp(secret, code, at, null)).toBeNull();
    });
  });

  it("builds an otpauth URI that authenticator apps understand", () => {
    const uri = otpauthUri("UlixOps", "admin@example.test", "ABCDEF");
    expect(uri).toBe(
      "otpauth://totp/UlixOps:admin%40example.test?secret=ABCDEF&issuer=UlixOps&algorithm=SHA1&digits=6&period=30",
    );
  });
});
