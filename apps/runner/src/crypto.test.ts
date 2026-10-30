import { describe, expect, it } from "vitest";
import { decryptBlob, encryptBlob, sha256Hex } from "./crypto";

const KEY = "ab".repeat(32);

describe("snapshot encryption", () => {
  it("round-trips with AAD binding", () => {
    const plain = Buffer.from("plugin zip bytes");
    const blob = encryptBlob(plain, KEY, "backupid1");
    expect(decryptBlob(blob, KEY, "backupid1").equals(plain)).toBe(true);
    expect(() => decryptBlob(blob, KEY, "otherid")).toThrow();
    expect(() => decryptBlob(blob, "cd".repeat(32), "backupid1")).toThrow();
  });

  it("hashes consistently", () => {
    expect(sha256Hex(Buffer.from("a"))).toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
  });
});
