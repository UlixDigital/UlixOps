import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { PASSWORD_MAX, PASSWORD_MIN } from "@ulixops/shared";

// OWASP minimum for argon2id: 19 MiB memory, 2 passes, 1 lane.
const PARAMS = { memory: 19456, passes: 2, parallelism: 1 } as const;
const FORMAT = /^argon2id\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

interface Params {
  memory: number;
  passes: number;
  parallelism: number;
}

function derive(password: string, nonce: Buffer, params: Params, tagLength: number) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2("argon2id", { message: password, nonce, tagLength, ...params }, (err, tag) =>
      err ? reject(err) : resolve(tag),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const tag = await derive(password, nonce, PARAMS, 32);
  const { memory, passes, parallelism } = PARAMS;
  return `argon2id$m=${memory},t=${passes},p=${parallelism}$${nonce.toString("base64url")}$${tag.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = FORMAT.exec(stored);
  if (!match) return false;
  const [, memory, passes, parallelism, salt, hash] = match;
  if (!memory || !passes || !parallelism || !salt || !hash) return false;
  const params = {
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
  };
  // Refuse parameters we would never write, so a tampered row cannot exhaust memory.
  if (params.memory > 262144 || params.passes > 10 || params.parallelism > 4) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), params, expected.length);
  return timingSafeEqual(actual, expected);
}

/** NIST-style rules: length only (counted in characters), and not the email address itself. */
export function isAcceptablePassword(password: string, email: string): boolean {
  const length = [...password].length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) return false;
  const lowered = password.toLowerCase();
  const localPart = email.toLowerCase().split("@")[0] ?? "";
  return lowered !== email.toLowerCase() && lowered !== localPart;
}
