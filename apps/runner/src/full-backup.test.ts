// `site.backup` (A145) with a fake SSH session and a fake Drive: the archive arrives encrypted
// and intact, old copies go only after verification, failures keep them, stop works, and no
// secret reaches the result.
import { randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ExecResult } from "@ulixops/shared";
import { describe, expect, it } from "vitest";
import { decryptBackup } from "./backup-crypto";
import { requestBackupCancel, runFullBackup } from "./full-backup";
import type { SshSession } from "./ssh";
import { packTar, unpackTar } from "./tar";
import { FakeDrive } from "./testing/fake-drive";
import { MemoryVault } from "./vault";

const KEY = "ab".repeat(32);
const PHOTO = randomBytes(200_000);
const target = {
  host: "site.example.test",
  port: 22,
  user: "wp",
  wpPath: "/sites/shop",
  credentialRef: "SHOP_SSH_KEY",
  hostKey: null,
};
const job = (over: Partial<Parameters<typeof runFullBackup>[2]> = {}) => ({
  backupId: "bk001",
  folderKey: "env001",
  folderName: "Shop (production)",
  fileStem: "shop-production",
  oldFileIds: [] as string[],
  ...over,
});

function vault(over: Record<string, string | null> = {}) {
  const v = new MemoryVault();
  const values: Record<string, string | null> = {
    GOOGLE_DRIVE_CLIENT_ID: "cid.apps.googleusercontent.com",
    GOOGLE_DRIVE_CLIENT_SECRET: "GOCSPX-secretvalue",
    GOOGLE_DRIVE_REFRESH_TOKEN: "1//refreshTOKENvalue",
    BACKUP_ENCRYPTION_KEY: KEY,
    ...over,
  };
  for (const [k, val] of Object.entries(values))
    if (val !== null) v.secrets.set(k, { value: val, at: new Date().toISOString() });
  return v;
}

/** The site: `db export` succeeds, the archive is a real tar.gz streamed in pieces. */
function site(opts: { dumpExit?: number; tarExit?: number; onChunk?: (i: number) => void } = {}) {
  const archive = gzipSync(
    packTar([
      { path: "ulixops-bk001.sql", data: Buffer.from("-- dump") },
      { path: "wp-config.php", data: Buffer.from("<?php // config") },
      // Random bytes don't compress, so the archive streams in many pieces.
      { path: "wp-content/uploads/photo.jpg", data: PHOTO },
    ]),
  );
  const calls: string[] = [];
  const unlinked: string[] = [];
  const session: SshSession = {
    hostKey: `SHA256:${"B".repeat(43)}`,
    exec: async (argv): Promise<ExecResult> => {
      calls.push(argv.join(" "));
      return {
        exitCode: opts.dumpExit ?? 0,
        stdout: "",
        stderr: opts.dumpExit ? "access denied" : "",
      };
    },
    execStream: async (argv, onChunk) => {
      calls.push(argv.join(" "));
      let i = 0;
      for (let p = 0; p < archive.length; p += 4096) {
        opts.onChunk?.(i++);
        if ((await onChunk(archive.subarray(p, p + 4096))) === "stop")
          return { exitCode: -1, stderr: "", stopped: true };
      }
      return {
        exitCode: opts.tarExit ?? 0,
        stderr: opts.tarExit ? "tar: oops" : "",
        stopped: false,
      };
    },
    sftp: async () =>
      ({
        unlink: async (p: string) => {
          unlinked.push(p);
        },
        close: () => undefined,
      }) as unknown as Awaited<ReturnType<SshSession["sftp"]>>,
    close: () => undefined,
  };
  return { session, calls, unlinked, archive };
}

const noSleep = async () => undefined;

describe("runFullBackup", () => {
  it("uploads an encrypted, verifiable archive and then removes the old copy", async () => {
    const drive = new FakeDrive();
    const old = "old-file-1";
    drive.files.set(old, { name: "old.ulxb", data: Buffer.from("x"), parents: [], folder: false });
    const s = site();
    const reports: string[] = [];
    const r = await runFullBackup(s.session, target, job({ oldFileIds: [old] }), "k", {
      vault: vault(),
      fetchImpl: drive.fetch,
      sleep: noSleep,
      progress: async (p) => {
        reports.push(p.phase);
      },
    });
    expect(r).toMatchObject({ ok: true, removed: [old], removeFailed: [] });
    expect(r.fileName).toMatch(/^shop-production-\d{8}-\d{4}\.tar\.gz\.ulxb$/);
    expect(s.calls[0]).toBe("wp --path=/sites/shop db export /tmp/ulixops-bk001.sql");
    expect(s.calls[1]).toMatch(/^tar -czf - .* -C \/tmp ulixops-bk001\.sql -C \/sites\/shop \.$/);
    expect(s.unlinked).toEqual(["/tmp/ulixops-bk001.sql"]);
    expect(drive.files.has(old)).toBe(false);
    const stored = drive.files.get(r.driveFileId ?? "");
    expect(stored?.data.length).toBe(r.sizeBytes);
    const files = unpackTar(
      gunzipSync(decryptBackup(stored?.data ?? Buffer.alloc(0), KEY)),
      100,
      1e9,
    );
    expect(files.map((f) => f.path)).toEqual([
      "ulixops-bk001.sql",
      "wp-config.php",
      "wp-content/uploads/photo.jpg",
    ]);
    expect(reports).toEqual(
      expect.arrayContaining(["database", "uploading", "verifying", "cleanup"]),
    );
    // Folders: "UlixOps Backups" / "Shop (production)".
    const folders = [...drive.files.values()].filter((f) => f.folder).map((f) => f.name);
    expect(folders).toEqual(["UlixOps Backups", "Shop (production)"]);
  });

  it("keeps the old copy when anything fails, and says why without secrets", async () => {
    const drive = new FakeDrive();
    drive.files.set("old-1", { name: "old", data: Buffer.from("x"), parents: [], folder: false });
    const dump = await runFullBackup(
      site({ dumpExit: 1 }).session,
      target,
      job({ oldFileIds: ["old-1"] }),
      "k",
      {
        vault: vault(),
        fetchImpl: drive.fetch,
        sleep: noSleep,
      },
    );
    expect(dump).toMatchObject({
      ok: false,
      detail: expect.stringContaining("database export failed"),
    });
    const tar = await runFullBackup(
      site({ tarExit: 2 }).session,
      target,
      job({ oldFileIds: ["old-1"] }),
      "k",
      {
        vault: vault(),
        fetchImpl: drive.fetch,
        sleep: noSleep,
      },
    );
    expect(tar).toMatchObject({ ok: false, detail: expect.stringContaining("tar exit 2") });
    drive.revoked = true;
    const revoked = await runFullBackup(
      site().session,
      target,
      job({ oldFileIds: ["old-1"] }),
      "k",
      {
        vault: vault(),
        fetchImpl: drive.fetch,
        sleep: noSleep,
      },
    );
    expect(revoked).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Connect Google Drive again"),
    });
    expect(drive.files.has("old-1")).toBe(true);
    for (const r of [dump, tar, revoked])
      for (const secret of ["GOCSPX-secretvalue", "1//refreshTOKENvalue", KEY])
        expect(JSON.stringify(r)).not.toContain(secret);
  });

  it("refuses to run without Drive or the backup key", async () => {
    const drive = new FakeDrive();
    const noDrive = await runFullBackup(site().session, target, job(), "k", {
      vault: vault({ GOOGLE_DRIVE_REFRESH_TOKEN: null }),
      fetchImpl: drive.fetch,
    });
    expect(noDrive.detail).toContain("isn't connected");
    const noKey = await runFullBackup(site().session, target, job(), "k", {
      vault: vault({ BACKUP_ENCRYPTION_KEY: null }),
      fetchImpl: drive.fetch,
    });
    expect(noKey.detail).toContain("No backup encryption key");
  });

  it("stops mid-upload on request and deletes nothing", async () => {
    const drive = new FakeDrive();
    drive.files.set("old-1", { name: "old", data: Buffer.from("x"), parents: [], folder: false });
    const s = site({
      onChunk: (i) => {
        if (i === 3) requestBackupCancel("bk009");
      },
    });
    const r = await runFullBackup(
      s.session,
      target,
      job({ backupId: "bk009", oldFileIds: ["old-1"] }),
      "k",
      {
        vault: vault(),
        fetchImpl: drive.fetch,
        sleep: noSleep,
      },
    );
    expect(r).toMatchObject({ ok: false, cancelled: true });
    expect(drive.files.has("old-1")).toBe(true);
    expect(s.unlinked).toEqual(["/tmp/ulixops-bk009.sql"]);
  });
});
