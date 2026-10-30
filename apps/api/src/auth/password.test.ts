import { describe, expect, it } from "vitest";
import { hashPassword, isAcceptablePassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^argon2id\$m=19456,t=2,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery stapler", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password here")).not.toBe(
      await hashPassword("same password here"),
    );
  });

  it("refuses malformed or tampered hashes instead of throwing", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(
      await verifyPassword("correct horse battery staple", hash.replace("m=19456", "m=9999999")),
    ).toBe(false);
  });
});

describe("password rules", () => {
  it.each([
    ["short", false],
    ["eleven char", false],
    ["twelve chars", true],
    ["ünïcödé pässwörd", true],
    ["x".repeat(129), false],
    ["admin@example.test", false],
    ["ADMIN@EXAMPLE.TEST", false],
  ])("%j acceptable: %s", (password, expected) => {
    expect(isAcceptablePassword(password, "admin@example.test")).toBe(expected);
  });
});
