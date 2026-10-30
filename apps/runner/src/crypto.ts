// AES-256-GCM for snapshot blobs at rest (spec §6.5). Binary layout, not the string form
// used for TOTP secrets: snapshots are large and must not be base64-wrapped on disk.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("UOS1"); // UlixOps Snapshot v1
const IV_LEN = 12;
const TAG_LEN = 16;

/** Encrypt `plain` with AAD = `bindTo` (the Backup id). Returns magic|iv|tag|ciphertext. */
export function encryptBlob(plain: Buffer, keyHex: string, bindTo: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  cipher.setAAD(Buffer.from(bindTo));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, body]);
}

export function decryptBlob(blob: Buffer, keyHex: string, bindTo: string): Buffer {
  if (blob.length < MAGIC.length + IV_LEN + TAG_LEN + 1) throw new Error("Snapshot blob too short");
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Unsupported snapshot format");
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const body = blob.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  decipher.setAAD(Buffer.from(bindTo));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
