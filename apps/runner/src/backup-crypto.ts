// Encryption for full backups on Google Drive (Phase 2 step 5, A145): streaming, chunked
// AES-256-GCM, so a multi-GB site never sits in memory and a truncated or altered file is
// detected. scripts/decrypt-backup.mjs implements the same format with no dependencies.
//
// Format "ULXB" v1:
//   header (16 bytes): "ULXB" | 0x01 | chunk size (uint32 BE) | nonce prefix (7 random bytes)
//   then chunks: ciphertext (chunk size bytes, the last one shorter or empty) + 16-byte tag
//   nonce = prefix (7) | chunk counter (uint32 BE) | 1 on the last chunk, else 0
//   additional data = the header, so it can't be swapped either
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const BACKUP_CHUNK = 1024 * 1024;
const MAGIC = Buffer.from("ULXB");
const HEADER = 16;
const TAG = 16;

function nonce(prefix: Buffer, counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, 7);
  n[11] = last ? 1 : 0;
  return n;
}

function keyOf(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("The backup key must be 64 hex characters");
  return Buffer.from(hex, "hex");
}

/** Encrypts a byte stream piece by piece: push() plaintext, finish() at the end. */
export class BackupEncryptor {
  private readonly key: Buffer;
  private readonly header: Buffer;
  private readonly prefix: Buffer;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private counter = 0;
  private started = false;

  constructor(
    keyHex: string,
    private readonly chunk = BACKUP_CHUNK,
  ) {
    this.key = keyOf(keyHex);
    this.prefix = randomBytes(7);
    this.header = Buffer.alloc(HEADER);
    MAGIC.copy(this.header, 0);
    this.header[4] = 1;
    this.header.writeUInt32BE(chunk, 5);
    this.prefix.copy(this.header, 9);
  }

  private seal(plain: Buffer, last: boolean): Buffer {
    if (this.counter > 0xffffffff) throw new Error("Backup too large for one file");
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.key,
      nonce(this.prefix, this.counter++, last),
    );
    cipher.setAAD(this.header);
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }

  /** Ciphertext ready to send (may be empty until a whole chunk is buffered). */
  push(data: Buffer): Buffer {
    const out: Buffer[] = [];
    if (!this.started) {
      this.started = true;
      out.push(this.header);
    }
    this.pending.push(data);
    this.pendingBytes += data.length;
    // Keep at least one byte back, so the last chunk is always sealed by finish().
    while (this.pendingBytes > this.chunk) {
      const all = Buffer.concat(this.pending);
      out.push(this.seal(all.subarray(0, this.chunk), false));
      const rest = all.subarray(this.chunk);
      this.pending = [rest];
      this.pendingBytes = rest.length;
    }
    return Buffer.concat(out);
  }

  finish(): Buffer {
    const head = this.started ? [] : [this.header];
    this.started = true;
    return Buffer.concat([...head, this.seal(Buffer.concat(this.pending), true)]);
  }
}

/** The key opened nothing, or a chunk was altered: Node's GCM error, in plain words. */
export class BackupDecryptError extends Error {}

/**
 * Decrypts a ULXB stream piece by piece (restore, A152): push() ciphertext, finish() at the end.
 * Only authenticated plaintext is ever returned; finish() throws if the file was cut short.
 */
export class BackupDecryptor {
  private readonly key: Buffer;
  private header: Buffer | null = null;
  private chunk = 0;
  private prefix = Buffer.alloc(0);
  private counter = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(keyHex: string) {
    this.key = keyOf(keyHex);
  }

  private open(piece: Buffer, last: boolean): Buffer {
    if (!this.header) throw new BackupDecryptError("Backup is truncated");
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, nonce(this.prefix, this.counter++, last));
      d.setAAD(this.header);
      d.setAuthTag(piece.subarray(piece.length - TAG));
      return Buffer.concat([d.update(piece.subarray(0, piece.length - TAG)), d.final()]);
    } catch {
      throw new BackupDecryptError(
        this.counter === 1
          ? "The backup can't be opened with the current backup key (wrong key, or a damaged file)."
          : "The backup file is damaged partway through.",
      );
    }
  }

  private take(bytes: number): Buffer {
    const only = this.pending.length === 1 ? this.pending[0] : undefined;
    const all = only ?? Buffer.concat(this.pending);
    const rest = all.subarray(bytes);
    this.pending = rest.length ? [rest] : [];
    this.pendingBytes = rest.length;
    return all.subarray(0, bytes);
  }

  /** Plaintext ready (may be empty until a whole chunk has arrived). */
  push(data: Buffer): Buffer {
    this.pending.push(data);
    this.pendingBytes += data.length;
    if (!this.header) {
      if (this.pendingBytes < HEADER) return Buffer.alloc(0);
      const header = Buffer.from(this.take(HEADER));
      if (!header.subarray(0, 4).equals(MAGIC) || header[4] !== 1)
        throw new BackupDecryptError("Not a UlixOps backup (ULXB v1)");
      this.chunk = header.readUInt32BE(5);
      if (this.chunk < 1 || this.chunk > 64 * 1024 * 1024)
        throw new BackupDecryptError("Not a UlixOps backup (bad chunk size)");
      this.prefix = header.subarray(9, 16);
      this.header = header;
    }
    const out: Buffer[] = [];
    // Keep the last piece back: only finish() knows it is the last chunk.
    while (this.pendingBytes > this.chunk + TAG)
      out.push(this.open(this.take(this.chunk + TAG), false));
    return Buffer.concat(out);
  }

  finish(): Buffer {
    if (!this.header || this.pendingBytes < TAG)
      throw new BackupDecryptError("Backup is truncated");
    return this.open(this.take(this.pendingBytes), true);
  }
}

/** Decrypts a whole ULXB buffer (tests and small files; the restore script streams). */
export function decryptBackup(data: Buffer, keyHex: string): Buffer {
  const key = keyOf(keyHex);
  if (data.length < HEADER + TAG || !data.subarray(0, 4).equals(MAGIC) || data[4] !== 1)
    throw new Error("Not a UlixOps backup (ULXB v1)");
  const header = data.subarray(0, HEADER);
  const chunk = header.readUInt32BE(5);
  const prefix = header.subarray(9, 16);
  const out: Buffer[] = [];
  let pos = HEADER;
  let counter = 0;
  for (;;) {
    const remaining = data.length - pos;
    const last = remaining <= chunk + TAG;
    const size = last ? remaining : chunk + TAG;
    if (size < TAG) throw new Error("Backup is truncated");
    const piece = data.subarray(pos, pos + size);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce(prefix, counter++, last));
    decipher.setAAD(header);
    decipher.setAuthTag(piece.subarray(size - TAG));
    out.push(decipher.update(piece.subarray(0, size - TAG)), decipher.final());
    pos += size;
    if (last) break;
  }
  return Buffer.concat(out);
}
