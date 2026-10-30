import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotStore } from "./snapshot-store";

const KEY = "cd".repeat(32);

describe("SnapshotStore content-addressed blobs", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("reuses an existing content blob when allowReuse is true", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ulixops-snap-"));
    const store = new SnapshotStore(root);
    const plain = Buffer.from("identical-plugin-tree");
    const first = await store.writeEncrypted("bak-a", plain, KEY, { allowReuse: true });
    const second = await store.writeEncrypted("bak-b", plain, KEY, { allowReuse: true });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.location).toBe(first.location);
    expect(second.sha256).toBe(first.sha256);
    expect(first.location).toMatch(/^quick\/content\/[0-9a-f]{64}\.bin$/);
    const roundTrip = await store.readDecrypted("bak-a", KEY, { location: first.location });
    expect(roundTrip.equals(plain)).toBe(true);
  });

  it("writes a unique legacy blob when allowReuse is false (DB snapshots)", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ulixops-snap-"));
    const store = new SnapshotStore(root);
    const plain = Buffer.from("with-database.sql");
    const saved = await store.writeEncrypted("bakdb1", plain, KEY, { allowReuse: false });
    expect(saved.reused).toBe(false);
    expect(saved.location).toBe("quick/bakdb1.bin");
    const roundTrip = await store.readDecrypted("bakdb1", KEY);
    expect(roundTrip.equals(plain)).toBe(true);
  });
});
