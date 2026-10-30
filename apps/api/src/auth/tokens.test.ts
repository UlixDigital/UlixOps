import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, newToken, tokenHash } from "./tokens";

const KEY = randomBytes(32).toString("hex");

describe("tokens", () => {
  it("makes unique 43-character base64url tokens", () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(token);
  });

  it("hashes with a key, so the same token hashes differently under another secret", () => {
    expect(tokenHash("t", "secret-a")).toBe(tokenHash("t", "secret-a"));
    expect(tokenHash("t", "secret-a")).not.toBe(tokenHash("t", "secret-b"));
  });
});

describe("secret encryption", () => {
  it("round-trips and never stores the plain value", () => {
    const blob = encryptSecret("JBSWY3DPEHPK3PXP", KEY, "user-1");
    expect(blob).toMatch(/^v1\./);
    expect(blob).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(blob, KEY, "user-1")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("fails if moved to another user, tampered with, or read with another key", () => {
    const blob = encryptSecret("JBSWY3DPEHPK3PXP", KEY, "user-1");
    expect(() => decryptSecret(blob, KEY, "user-2")).toThrow();
    const [v, iv, tag, body] = blob.split(".");
    const flipped = `${body?.startsWith("A") ? "B" : "A"}${body?.slice(1)}`;
    expect(() => decryptSecret([v, iv, tag, flipped].join("."), KEY, "user-1")).toThrow();
    expect(() => decryptSecret(blob, randomBytes(32).toString("hex"), "user-1")).toThrow();
    expect(() => decryptSecret("v2.a.b.c", KEY, "user-1")).toThrow(/format/);
  });
});
