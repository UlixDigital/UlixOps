// On-disk snapshot blobs. The runner writes encrypted files; the API only deletes expired
// ones by known paths (never decrypts — agent decision A68/A69). Supports legacy
// quick/<backupId>.bin and content-addressed quick/content/<sha256>.bin (A103).
import { access, rm } from "node:fs/promises";
import path from "node:path";

const ID = /^[a-z0-9]{1,64}$/;
const LOCATION = /^quick\/(?:[a-z0-9]{1,64}|content\/[0-9a-f]{64})\.bin$/;

export class SnapshotStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error("SNAPSHOT_STORE_DIR must be an absolute path");
  }

  /** Relative location as stored on Backup.location. */
  pathOf(location: string): string {
    if (!LOCATION.test(location)) {
      throw new Error("invalid snapshot location");
    }
    return path.join(this.root, location);
  }

  /** Legacy per-backup location (still used when includeDb forces a unique blob). */
  locationFor(backupId: string): string {
    if (!ID.test(backupId)) throw new Error("invalid backup id");
    return `quick/${backupId}.bin`;
  }

  async exists(location: string): Promise<boolean> {
    try {
      await access(this.pathOf(location));
      return true;
    } catch {
      return false;
    }
  }

  async remove(location: string): Promise<void> {
    await rm(this.pathOf(location), { force: true });
  }
}
