// Encrypted snapshot blobs on disk. Only the runner encrypts/decrypts; the API may delete
// expired files by path (agent decision A68). Content-addressed blobs use AAD = content SHA
// (A103); legacy blobs use AAD = backup id.
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptBlob, encryptBlob, sha256Hex } from "./crypto";

const ID = /^[a-z0-9]{1,64}$/;
const CONTENT_SHA = /^[0-9a-f]{64}$/;

export class SnapshotStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error("SNAPSHOT_STORE_DIR must be an absolute path");
  }

  /** Legacy per-backup path (AAD = backupId). */
  pathFor(backupId: string): string {
    if (!ID.test(backupId)) throw new Error("invalid backup id");
    return path.join(this.root, "quick", `${backupId}.bin`);
  }

  /** Content-addressed path (AAD = contentSha256). */
  pathForContent(contentSha256: string): string {
    if (!CONTENT_SHA.test(contentSha256)) throw new Error("invalid content sha256");
    return path.join(this.root, "quick", "content", `${contentSha256}.bin`);
  }

  locationForContent(contentSha256: string): string {
    if (!CONTENT_SHA.test(contentSha256)) throw new Error("invalid content sha256");
    return `quick/content/${contentSha256}.bin`;
  }

  locationForLegacy(backupId: string): string {
    if (!ID.test(backupId)) throw new Error("invalid backup id");
    return `quick/${backupId}.bin`;
  }

  /**
   * Write an encrypted snapshot. When `allowReuse` is true (no DB), store under the plaintext
   * content hash and skip the write if that blob already exists (A103).
   */
  async writeEncrypted(
    backupId: string,
    plain: Buffer,
    keyHex: string,
    opts: { allowReuse: boolean } = { allowReuse: true },
  ): Promise<{
    location: string;
    sha256: string;
    sizeBytes: number;
    reused: boolean;
  }> {
    const contentSha256 = sha256Hex(plain);
    if (opts.allowReuse) {
      const location = this.locationForContent(contentSha256);
      const file = this.pathForContent(contentSha256);
      try {
        const info = await stat(file);
        return {
          location,
          sha256: contentSha256,
          sizeBytes: info.size,
          reused: true,
        };
      } catch {
        // Not present yet — write below.
      }
      const encrypted = encryptBlob(plain, keyHex, contentSha256);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, encrypted, { mode: 0o640, flag: "wx" });
      try {
        await rename(temp, file);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        // Race: another capture wrote the same content hash.
        try {
          const info = await stat(file);
          return { location, sha256: contentSha256, sizeBytes: info.size, reused: true };
        } catch {
          throw error;
        }
      }
      return { location, sha256: contentSha256, sizeBytes: encrypted.length, reused: false };
    }

    const location = this.locationForLegacy(backupId);
    const file = this.pathFor(backupId);
    const encrypted = encryptBlob(plain, keyHex, backupId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, encrypted, { mode: 0o640, flag: "wx" });
    await rename(temp, file);
    return {
      location,
      sha256: contentSha256,
      sizeBytes: encrypted.length,
      reused: false,
    };
  }

  async readDecrypted(
    backupId: string,
    keyHex: string,
    opts?: { location?: string; contentSha256?: string | null },
  ): Promise<Buffer> {
    const location = opts?.location;
    if (location?.startsWith("quick/content/")) {
      const sha = location.slice("quick/content/".length, -".bin".length);
      const encrypted = await readFile(this.pathForContent(sha));
      return decryptBlob(encrypted, keyHex, sha);
    }
    if (opts?.contentSha256 && CONTENT_SHA.test(opts.contentSha256)) {
      // New Backup rows store content hash in sha256 even when location is legacy — prefer location.
    }
    const encrypted = await readFile(this.pathFor(backupId));
    return decryptBlob(encrypted, keyHex, backupId);
  }

  async remove(backupId: string): Promise<void> {
    await rm(this.pathFor(backupId), { force: true });
  }

  async removeLocation(location: string): Promise<void> {
    if (location.startsWith("quick/content/")) {
      const sha = location.slice("quick/content/".length, -".bin".length);
      await rm(this.pathForContent(sha), { force: true });
      return;
    }
    const id = location.match(/^quick\/([a-z0-9]{1,64})\.bin$/)?.[1];
    if (!id) throw new Error("invalid snapshot location");
    await rm(this.pathFor(id), { force: true });
  }

  async existsLocation(location: string): Promise<boolean> {
    try {
      if (location.startsWith("quick/content/")) {
        const sha = location.slice("quick/content/".length, -".bin".length);
        await access(this.pathForContent(sha));
      } else {
        const id = location.match(/^quick\/([a-z0-9]{1,64})\.bin$/)?.[1];
        if (!id) return false;
        await access(this.pathFor(id));
      }
      return true;
    } catch {
      return false;
    }
  }
}
