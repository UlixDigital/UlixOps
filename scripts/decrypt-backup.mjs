#!/usr/bin/env node
// Decrypts a UlixOps full backup downloaded from Google Drive (A145). No dependencies: works on
// any machine with Node 18+, even if the hub is gone.
//
//   BACKUP_KEY=<64 hex characters> node scripts/decrypt-backup.mjs <backup.tar.gz.ulxb> <out.tar.gz>
//   tar -xzf out.tar.gz        # WordPress files, plus ulixops-<id>.sql (the database) at the top
//
// Format: see apps/runner/src/backup-crypto.ts. Stops with an error if the file was truncated or
// altered (every 1 MB chunk is authenticated, and the last chunk is marked).
import { createDecipheriv } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";

const TAG = 16;

function nonce(prefix, counter, last) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, 7);
  n[11] = last ? 1 : 0;
  return n;
}

/** Streams `input` (ULXB) to `output` (the .tar.gz). Throws on a wrong key or damaged file. */
export async function decryptFile(input, output, keyHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("The key must be 64 hex characters");
  const key = Buffer.from(keyHex, "hex");
  const out = createWriteStream(output, { mode: 0o600 });
  const write = (data) =>
    new Promise((resolve, reject) => out.write(data, (e) => (e ? reject(e) : resolve())));
  let header = null;
  let chunk = 0;
  let prefix = null;
  let counter = 0;
  let buf = Buffer.alloc(0);
  const open = (piece, last) => {
    const d = createDecipheriv("aes-256-gcm", key, nonce(prefix, counter++, last));
    d.setAAD(header);
    d.setAuthTag(piece.subarray(piece.length - TAG));
    return Buffer.concat([d.update(piece.subarray(0, piece.length - TAG)), d.final()]);
  };
  try {
    for await (const data of createReadStream(input)) {
      buf = Buffer.concat([buf, data]);
      if (!header) {
        if (buf.length < 16) continue;
        header = buf.subarray(0, 16);
        if (header.subarray(0, 4).toString() !== "ULXB" || header[4] !== 1)
          throw new Error("Not a UlixOps backup (ULXB v1)");
        chunk = header.readUInt32BE(5);
        prefix = header.subarray(9, 16);
        buf = buf.subarray(16);
      }
      // Only open a chunk once more bytes follow it, so the last one is opened as last.
      while (buf.length > chunk + TAG) {
        await write(open(buf.subarray(0, chunk + TAG), false));
        buf = buf.subarray(chunk + TAG);
      }
    }
    if (!header || buf.length < TAG) throw new Error("Backup is truncated");
    await write(open(buf, true));
    await new Promise((resolve) => out.end(resolve));
    return counter;
  } catch (error) {
    out.destroy();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  const keyHex = (process.env.BACKUP_KEY ?? "").trim();
  if (!input || !output) {
    console.error("Usage: BACKUP_KEY=<hex> node scripts/decrypt-backup.mjs <in.ulxb> <out.tar.gz>");
    process.exit(2);
  }
  try {
    const chunks = await decryptFile(input, output, keyHex);
    console.log(`Decrypted ${chunks} chunks to ${output}.`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `Could not decrypt: ${/auth|unable/i.test(msg) ? "wrong key, or the file was altered or cut short" : msg}`,
    );
    process.exit(1);
  }
}
