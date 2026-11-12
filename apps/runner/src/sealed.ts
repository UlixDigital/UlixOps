// Sealing secrets to the runner (A133). The API encrypts an API key the user typed with this
// public key, so the queue (Redis) only ever holds ciphertext. The private key lives in this
// process's memory only and is replaced on every restart.
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  privateDecrypt,
  constants,
} from "node:crypto";
import type { SealKeyResult } from "@ulixops/shared";

export class StaleSealKeyError extends Error {}

export class SealKeys {
  private pair: { keyId: string; publicKey: string; privateKey: KeyObject } | null = null;

  private current() {
    if (!this.pair) {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
      const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const der = publicKey.export({ type: "spki", format: "der" });
      const keyId = createHash("sha256").update(der).digest("hex").slice(0, 32);
      this.pair = { keyId, publicKey: pem, privateKey };
    }
    return this.pair;
  }

  publicKey(): SealKeyResult {
    const { keyId, publicKey } = this.current();
    return { keyId, publicKey };
  }

  /** Decrypts RSA-OAEP (SHA-256) ciphertext sealed to the current key. */
  open(keyId: string, ciphertextBase64: string): string {
    const pair = this.current();
    if (keyId !== pair.keyId) throw new StaleSealKeyError("The runner restarted; try again.");
    return privateDecrypt(
      { key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(ciphertextBase64, "base64"),
    ).toString("utf8");
  }
}
