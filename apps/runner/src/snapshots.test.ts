import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecResult, SshTarget } from "@ulixops/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotStore } from "./snapshot-store";
import { restoreSnapshot } from "./snapshots";
import type { SftpSession, SshSession } from "./ssh";
import { zipStore } from "./zip";

const KEY = "ab".repeat(32);
const target: SshTarget = {
  host: "test-wp",
  port: 22,
  user: "wpdev",
  wpPath: "/var/www/html",
  credentialRef: "SSH_KEY_TEST",
  hostKey: null,
};

function manifest(plugin = "hello", includesDb = false) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      plugin,
      pluginVersion: "1.0.0",
      includesDb,
      createdAt: "2026-10-29T12:00:00.000Z",
    }),
    "utf8",
  );
}

describe("restoreSnapshot", () => {
  let root = "";
  let store: SnapshotStore;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function prep(files: Map<string, Buffer>) {
    root = await mkdtemp(path.join(tmpdir(), "ulixops-restore-"));
    store = new SnapshotStore(root);
    // Legacy per-backup path so restore can open by backupId without a location (tests).
    await store.writeEncrypted("bak1", zipStore(files), KEY, { allowReuse: false });
  }

  function fakeSession(opts: {
    exec?: (argv: readonly string[]) => Promise<ExecResult>;
    sftp: Partial<SftpSession> & Pick<SftpSession, "stat" | "rename" | "rmTree" | "writeFile">;
  }): SshSession {
    const sftp: SftpSession = {
      readFile: vi.fn(),
      readFileTail: vi.fn(),
      mkdirp: vi.fn(),
      readTree: vi.fn(),
      writeTree: vi.fn(),
      unlink: vi.fn(async () => undefined),
      close: vi.fn(),
      ...opts.sftp,
    };
    return {
      hostKey: `SHA256:${"B".repeat(43)}`,
      exec: opts.exec ?? (async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      sftp: async () => sftp,
      close: vi.fn(),
    };
  }

  it("fails when includesDb is requested but database.sql is missing", async () => {
    await prep(
      new Map([
        ["manifest.json", manifest("hello", true)],
        ["plugin/hello.php", Buffer.from("<?php\n// Plugin Name: Hello\n")],
      ]),
    );
    const rename = vi.fn(async () => undefined);
    const rmTree = vi.fn(async () => undefined);
    const session = fakeSession({
      sftp: {
        stat: vi.fn(async (p) =>
          p.endsWith(".__ulixops_old__")
            ? { isDirectory: false, size: 1 }
            : p.endsWith("hello.php")
              ? { isDirectory: false, size: 10 }
              : null,
        ),
        rename,
        rmTree,
        writeFile: vi.fn(async () => undefined),
      },
    });
    const result = await restoreSnapshot(
      session,
      target,
      { backupId: "bak1", plugin: "hello", includesDb: true },
      "secret",
      { store, encryptionKey: KEY },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/missing database\.sql/i);
    // Plugin upload then rolled back from bak.
    expect(rename).toHaveBeenCalled();
  });

  it("rolls plugins back and keeps bak when db.import fails", async () => {
    await prep(
      new Map([
        ["manifest.json", manifest("hello", true)],
        ["plugin/hello.php", Buffer.from("<?php\n")],
        ["database.sql", Buffer.from("SELECT 1;")],
      ]),
    );
    const paths = new Set<string>(["/var/www/html/wp-content/plugins/hello.php"]);
    const rename = vi.fn(async (from: string, to: string) => {
      paths.delete(from);
      paths.add(to);
    });
    const session = fakeSession({
      exec: async (argv) => {
        if (argv.includes("db") && argv.includes("import")) {
          return { exitCode: 1, stdout: "", stderr: "import failed" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      sftp: {
        stat: vi.fn(async (p) => (paths.has(p) ? { isDirectory: false, size: 1 } : null)),
        rename,
        rmTree: vi.fn(async (p: string) => {
          paths.delete(p);
        }),
        writeFile: vi.fn(async (p) => {
          paths.add(p);
        }),
      },
    });
    const result = await restoreSnapshot(
      session,
      target,
      { backupId: "bak1", plugin: "hello", includesDb: true },
      "secret",
      { store, encryptionKey: KEY },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/DB import failed/i);
    const remote = "/var/www/html/wp-content/plugins/hello.php";
    const bak = `${remote}.__ulixops_old__`;
    // On DB failure we put the pre-restore copy back (rename bak → remote).
    expect(rename.mock.calls.some(([from, to]) => from === bak && to === remote)).toBe(true);
    expect(paths.has(remote)).toBe(true);
    expect(paths.has(bak)).toBe(false);
  });

  it("returns structured failure for corrupt manifest JSON", async () => {
    await prep(
      new Map([
        ["manifest.json", Buffer.from("{not-json", "utf8")],
        ["plugin/hello.php", Buffer.from("<?php\n")],
      ]),
    );
    const session = fakeSession({
      sftp: {
        stat: vi.fn(async () => null),
        rename: vi.fn(),
        rmTree: vi.fn(),
        writeFile: vi.fn(),
      },
    });
    const result = await restoreSnapshot(
      session,
      target,
      { backupId: "bak1", plugin: "hello", includesDb: false },
      "secret",
      { store, encryptionKey: KEY },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("Snapshot manifest invalid");
  });

  it("removes the plugin when the snapshot has no plugin files (first-install rollback)", async () => {
    await prep(new Map([["manifest.json", manifest("ulixops-e2e-probe", false)]]));
    const unlink = vi.fn(async () => undefined);
    const rmTree = vi.fn(async () => undefined);
    const session = fakeSession({
      sftp: {
        stat: vi.fn(async () => null),
        rename: vi.fn(),
        rmTree,
        writeFile: vi.fn(),
        unlink,
      },
    });
    const result = await restoreSnapshot(
      session,
      target,
      { backupId: "bak1", plugin: "ulixops-e2e-probe", includesDb: false },
      "secret",
      { store, encryptionKey: KEY },
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/Removed ulixops-e2e-probe/);
    expect(rmTree).toHaveBeenCalled();
  });
});
