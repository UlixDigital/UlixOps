// The ULXB format (A145): round trip, chunk edges, and that tampering, truncation, a wrong key
// and a missing last chunk are all refused. Also checks the standalone restore script.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decryptFile } from "../../../scripts/decrypt-backup.mjs";
import {
  BackupDecryptError,
  BackupDecryptor,
  BackupEncryptor,
  decryptBackup,
} from "./backup-crypto";

const KEY = "ab".repeat(32);

function encrypt(plain: Buffer, chunk = 64, pieces = 7): Buffer {
  const enc = new BackupEncryptor(KEY, chunk);
  const out: Buffer[] = [];
  for (let i = 0; i < plain.length; i += pieces) out.push(enc.push(plain.subarray(i, i + pieces)));
  out.push(enc.finish());
  return Buffer.concat(out);
}

describe("backup encryption", () => {
  it.each([0, 1, 63, 64, 65, 128, 1000])("round-trips %i bytes", (n) => {
    const plain = Buffer.from(Array.from({ length: n }, (_, i) => i % 251));
    expect(decryptBackup(encrypt(plain), KEY).equals(plain)).toBe(true);
  });

  it("refuses a wrong key, a changed byte, a cut-off file and a dropped last chunk", () => {
    const plain = Buffer.alloc(500, 7);
    const data = encrypt(plain);
    expect(() => decryptBackup(data, "cd".repeat(32))).toThrow();
    const changed = Buffer.from(data);
    changed[100] = (changed[100] ?? 0) ^ 1;
    expect(() => decryptBackup(changed, KEY)).toThrow();
    expect(() => decryptBackup(data.subarray(0, data.length - 10), KEY)).toThrow();
    // Cut exactly at a chunk boundary: the remaining chunk wasn't sealed as the last one.
    expect(() => decryptBackup(data.subarray(0, 16 + 2 * (64 + 16)), KEY)).toThrow();
    expect(() => decryptBackup(Buffer.from("not a backup at all......"), KEY)).toThrow(/ULXB/);
  });

  it("is decrypted by the standalone restore script", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulxb-"));
    try {
      const plain = Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => (i * 7) % 256));
      const enc = new BackupEncryptor(KEY);
      const data = Buffer.concat([enc.push(plain), enc.finish()]);
      writeFileSync(path.join(dir, "b.ulxb"), data);
      expect(await decryptFile(path.join(dir, "b.ulxb"), path.join(dir, "out"), KEY)).toBe(3);
      expect(readFileSync(path.join(dir, "out")).equals(plain)).toBe(true);
      writeFileSync(path.join(dir, "cut.ulxb"), data.subarray(0, data.length - 5));
      await expect(
        decryptFile(path.join(dir, "cut.ulxb"), path.join(dir, "o2"), KEY),
      ).rejects.toThrow();
      await expect(
        decryptFile(path.join(dir, "b.ulxb"), path.join(dir, "o3"), "cd".repeat(32)),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Streams `data` through BackupDecryptor in pieces of `size`. */
function streamDecrypt(data: Buffer, size: number, key = KEY): Buffer {
  const dec = new BackupDecryptor(key);
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += size) out.push(dec.push(data.subarray(i, i + size)));
  out.push(dec.finish());
  return Buffer.concat(out);
}

describe("streaming decryption (restore, A152)", () => {
  it("returns the original bytes whatever size the pieces arrive in", () => {
    for (const length of [0, 1, 63, 64, 65, 1000]) {
      const plain = Buffer.from(Array.from({ length }, (_, i) => i % 251));
      const data = encrypt(plain);
      for (const size of [1, 5, 16, 80, 4096]) expect(streamDecrypt(data, size)).toEqual(plain);
    }
  });

  it("refuses a wrong key, damage, a cut-off file and a foreign file", () => {
    const data = encrypt(Buffer.alloc(500, 7));
    expect(() => streamDecrypt(data, 33, "cd".repeat(32))).toThrow(/current backup key/);
    const damaged = Buffer.from(data);
    damaged[300] = (damaged[300] ?? 0) ^ 1;
    expect(() => streamDecrypt(damaged, 33)).toThrow(/damaged partway/);
    expect(() => streamDecrypt(data.subarray(0, data.length - 100), 33)).toThrow(
      BackupDecryptError,
    );
    expect(() => streamDecrypt(Buffer.from("PK\u0003\u0004 not a backup at all"), 8)).toThrow(
      /Not a UlixOps backup/,
    );
  });
});
