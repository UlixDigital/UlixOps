import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/** 32 random bytes as base64url (43 chars): session, challenge, setup and device tokens. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are stored only as this keyed hash, so a database leak alone cannot replay them. */
export function tokenHash(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

/**
 * AES-256-GCM. `bindTo` (e.g. the user id) is authenticated but not stored, so a ciphertext
 * copied onto another row fails to decrypt.
 */
export function encryptSecret(plain: string, keyHex: string, bindTo: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  cipher.setAAD(Buffer.from(bindTo));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url"));
  return ["v1", ...parts].join(".");
}

export function decryptSecret(blob: string, keyHex: string, bindTo: string): string {
  const [version, iv, tag, body] = blob.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(bindTo));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
