// PNG files for visual checks live on the shared visual-store volume (A163).
import { createReadStream } from "node:fs";
import { access, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

const SAFE_ID = /^[a-z0-9]{1,64}$/;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,120}\.png$/;

export class VisualStore {
  constructor(private readonly root: string) {}

  private checkDir(checkId: string): string {
    if (!SAFE_ID.test(checkId)) throw new Error("invalid check id");
    return path.join(this.root, checkId);
  }

  async exists(checkId: string, file: string): Promise<boolean> {
    if (!SAFE_FILE.test(file)) return false;
    try {
      await access(path.join(this.checkDir(checkId), file));
      return true;
    } catch {
      return false;
    }
  }

  open(checkId: string, file: string): Readable {
    if (!SAFE_FILE.test(file)) throw new Error("invalid file");
    return createReadStream(path.join(this.checkDir(checkId), file));
  }

  async removeCheck(checkId: string): Promise<void> {
    await rm(this.checkDir(checkId), { recursive: true, force: true });
  }

  /** Delete check folders older than `keepDays`, keeping at most `keepPerEnv` newest by mtime. */
  async purge(keepDays: number, keepNewest = 200): Promise<number> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return 0;
    }
    const dirs = (
      await Promise.all(
        entries
          .filter((e) => e.isDirectory() && SAFE_ID.test(e.name))
          .map(async (e) => {
            const p = path.join(this.root, e.name);
            const s = await stat(p);
            return { id: e.name, mtime: s.mtimeMs };
          }),
      )
    ).sort((a, b) => b.mtime - a.mtime);

    const cutoff = Date.now() - keepDays * 24 * 60 * 60_000;
    let removed = 0;
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      if (!d) continue;
      if (i >= keepNewest || d.mtime < cutoff) {
        await this.removeCheck(d.id);
        removed++;
      }
    }
    return removed;
  }
}
