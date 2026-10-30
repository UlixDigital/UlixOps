// Plugin ZIPs on disk, outside any web root (spec 5): PLUGIN_STORE_DIR is a volume only the API
// writes. Paths are built from validated ids and checksums only, never from upload names.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ID = /^[a-z0-9]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class PluginStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error("PLUGIN_STORE_DIR must be an absolute path");
  }

  private uploadPath(id: string) {
    if (!ID.test(id)) throw new Error("invalid upload id");
    return path.join(this.root, "uploads", `${id}.zip`);
  }

  /** Quarantines a checked upload until it is saved or expires. */
  async saveUpload(id: string, data: Buffer): Promise<void> {
    const file = this.uploadPath(id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
    await writeAtomically(file, data);
  }

  async readUpload(id: string): Promise<Buffer | null> {
    try {
      return await readFile(this.uploadPath(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async removeUpload(id: string): Promise<void> {
    await rm(this.uploadPath(id), { force: true });
  }

  /**
   * Stores a version by its content: versions/<sha256>.zip. Writing the same content twice is
   * harmless. The checksum is computed here, so the key always matches the bytes.
   */
  async saveVersion(data: Buffer): Promise<{ storageKey: string; sha256: string }> {
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (!SHA256.test(sha256)) throw new Error("unexpected checksum");
    const storageKey = `versions/${sha256}.zip`;
    const file = path.join(this.root, storageKey);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
    await writeAtomically(file, data);
    return { storageKey, sha256 };
  }
}

/** Write to a temporary name, then rename, so a reader never sees half a file. */
async function writeAtomically(file: string, data: Buffer) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, data, { mode: 0o640, flag: "wx" });
  await rename(temp, file);
}
