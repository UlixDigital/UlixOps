// RFC 6238 TOTP (SHA-1, 6 digits, 30 s): what authenticator apps support.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(input: string): Buffer {
  let value = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, as RFC 4226 recommends. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function timeStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / PERIOD_SECONDS);
}

export function totpAt(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/**
 * Accepts the current step and one either side (clock drift). Steps at or before
 * `lastUsedStep` are refused so a code can never be used twice. Returns the matched step.
 */
export function verifyTotp(
  secret: string,
  code: string,
  at: Date,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const now = timeStep(at);
  for (const step of [now - 1, now, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(totpAt(key, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
