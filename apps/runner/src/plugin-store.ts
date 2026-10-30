// Read-only access to registry plugin ZIPs (PLUGIN_STORE_DIR). Paths are built from the
// validated storageKey only — never from remote input (agent decision A63 / A81).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const STORAGE_KEY = /^versions\/([0-9a-f]{64})\.zip$/;

export class PluginStoreReader {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error("PLUGIN_STORE_DIR must be an absolute path");
  }

  /** Reads versions/<sha256>.zip and checks the bytes match the expected checksum. */
  async readVersion(storageKey: string, expectedSha256: string): Promise<Buffer> {
    const match = STORAGE_KEY.exec(storageKey);
    if (!match || match[1] !== expectedSha256) {
      throw new Error("Invalid plugin storage key");
    }
    const file = path.join(this.root, "versions", `${expectedSha256}.zip`);
    // Refuse path escape if root itself is weirdly linked.
    if (!file.startsWith(path.join(this.root, "versions") + path.sep)) {
      throw new Error("Invalid plugin storage path");
    }
    const data = await readFile(file);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sha256 !== expectedSha256) throw new Error("Plugin ZIP checksum mismatch");
    return data;
  }
}
