// `site.backup.restore` (A152) with a fake SSH session and a fake Drive: the key is checked
// first, a safety copy is made before anything changes, the backup streams decrypted into tar,
// and every failure says whether the site was touched, without secrets.
import { randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ExecResult } from "@ulixops/shared";
import { describe, expect, it } from "vitest";
import { BackupEncryptor } from "./backup-crypto";
import { type FullRestoreJob, runFullRestore } from "./full-restore";
import type { SshSession } from "./ssh";
import { packTar, unpackTar } from "./tar";
import { FakeDrive } from "./testing/fake-drive";
import { MemoryVault } from "./vault";

const KEY = "ab".repeat(32);
const PHOTO = randomBytes(300_000);
const target = {
  host: "site.example.test",
  port: 22,
  user: "wp",
  wpPath: "/sites/shop",
  credentialRef: "SHOP_SSH_KEY",
  hostKey: null,
};

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

/** The weekly backup "src001" on Drive, as site.backup made it. */
function driveWithBackup(key = KEY) {
  const drive = new FakeDrive();
  const archive = gzipSync(
    packTar([
      { path: "ulixops-src001.sql", data: Buffer.from("-- dump of last week") },
      { path: "./wp-config.php", data: Buffer.from("<?php // config") },
      { path: "./wp-content/uploads/photo.jpg", data: PHOTO },
    ]),
  );
  const enc = new BackupEncryptor(key);
  const data = Buffer.concat([enc.push(archive), enc.finish()]);
  drive.files.set("backup-file-1", { name: "shop.ulxb", data, parents: [], folder: false });
  return { drive, archive };
}

/** The site: every command succeeds unless told otherwise; stdin of tar is captured. */
function site(
  opts: {
    importExit?: number;
    filesExit?: number;
    filesStderr?: string;
    readDbOnly?: boolean;
    /** Table prefix of this site (`wp db prefix`); the backup's dump uses wp_. */
    sitePrefix?: string;
    /** Fail `wp db prefix` (A173). */
    prefixExit?: number;
    prefixStderr?: string;
    /** Override dump-prefix grep stdout (A173). */
    dumpCreateLine?: string;
    dumpExit?: number;
  } = {},
) {
  const calls: string[] = [];
  const stdin: Record<string, Buffer> = {};
  const unlinked: string[] = [];
  const session: SshSession = {
    hostKey: `SHA256:${"B".repeat(43)}`,
    exec: async (argv): Promise<ExecResult> => {
      const line = argv.join(" ");
      calls.push(line);
      if (line.startsWith("grep -m 1"))
        return {
          exitCode: opts.dumpExit ?? 0,
          stdout: opts.dumpCreateLine ?? "CREATE TABLE `wp_options`\n",
          stderr: "",
        };
      if (line.includes(" db prefix"))
        return {
          exitCode: opts.prefixExit ?? 0,
          stdout: opts.prefixExit ? "" : `${opts.sitePrefix ?? "wp_"}\n`,
          stderr: opts.prefixStderr ?? "",
        };
      if (line.includes("db import"))
        return {
          exitCode: opts.importExit ?? 0,
          stdout: "",
          stderr: opts.importExit
            ? "ERROR 1045 (28000): Access denied; key=1//refreshTOKENvalue"
            : "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    // The safety copy's archive of the site as it is now.
    execStream: async (argv, onChunk) => {
      calls.push(argv.join(" "));
      await onChunk(gzipSync(packTar([{ path: "./index.php", data: Buffer.from("now") }])));
      return { exitCode: 0, stderr: "", stopped: false };
    },
    execUpload: async (argv, source) => {
      const line = argv.join(" ");
      calls.push(line);
      const db = argv.includes("--occurrence=1");
      const got: Buffer[] = [];
      let size = 0;
      for await (const chunk of source) {
        got.push(chunk);
        size += chunk.length;
        // tar --occurrence stops reading once it has the dump.
        if (db && opts.readDbOnly && size > 1024) {
          stdin[db ? "database" : "files"] = Buffer.concat(got);
          return { exitCode: 0, stderr: "", consumed: false };
        }
      }
      stdin[db ? "database" : "files"] = Buffer.concat(got);
      if (db) return { exitCode: 0, stderr: "", consumed: true };
      return {
        exitCode: opts.filesExit ?? 0,
        stderr: opts.filesStderr ?? "",
        consumed: true,
      };
    },
    sftp: async () =>
      ({
        stat: async () => null,
        unlink: async (p: string) => {
          unlinked.push(p);
        },
        close: () => undefined,
      }) as unknown as Awaited<ReturnType<SshSession["sftp"]>>,
    close: () => undefined,
  };
  return { session, calls, stdin, unlinked };
}

const job = (over: Partial<FullRestoreJob> = {}): FullRestoreJob => ({
  restoreId: "rst001",
  driveFileId: "backup-file-1",
  sourceBackupId: "src001",
  scope: "ALL",
  safetyBackupId: "safe001",
  folderKey: "env001",
  folderName: "Shop (production)",
  fileStem: "shop-production",
  ...over,
});

const noSleep = async () => undefined;

describe("runFullRestore", () => {
  it("checks the key, makes a safety copy, then restores the database and the files", async () => {
    const { drive, archive } = driveWithBackup();
    const s = site();
    const phases: string[] = [];
    const r = await runFullRestore(s.session, target, job(), "k", {
      vault: vault(),
      fetchImpl: drive.fetch,
      sleep: noSleep,
      progress: async (p) => {
        phases.push(p.phase);
      },
    });
    expect(r).toMatchObject({ ok: true, changed: true, database: true, files: true });
    expect(r.detail).toBe("Restored the database and files from the backup.");
    // Safety copy on Drive first, named so it can be told apart.
    expect(r.safety?.fileName).toMatch(
      /^shop-production-before-restore-\d{8}-\d{4}\.tar\.gz\.ulxb$/,
    );
    expect(drive.files.has(r.safety?.driveFileId ?? "")).toBe(true);
    expect(s.calls).toEqual([
      "wp --path=/sites/shop db export /tmp/ulixops-safe001.sql",
      expect.stringMatching(/^tar -czf - .* -C \/tmp ulixops-safe001\.sql -C \/sites\/shop \.$/),
      expect.stringMatching(/^wp --path=\/sites\/shop maintenance-mode activate/),
      "tar -xzf - --occurrence=1 --no-same-owner -C /tmp ulixops-src001.sql",
      "wp --path=/sites/shop db import /tmp/ulixops-src001.sql",
      "tar -xzf - --no-same-owner --no-overwrite-dir --exclude=ulixops-src001.sql --exclude=./wp-config.php -C /sites/shop",
      expect.stringMatching(/^wp --path=\/sites\/shop cache flush/),
      expect.stringMatching(/^wp --path=\/sites\/shop maintenance-mode deactivate/),
    ]);
    // tar got the decrypted archive, byte for byte.
    expect(s.stdin.files).toEqual(archive);
    expect(unpackTar(gunzipSync(s.stdin.files ?? Buffer.alloc(0)), 100, 1e9).length).toBe(3);
    expect(s.unlinked).toEqual(
      expect.arrayContaining(["/tmp/ulixops-safe001.sql", "/tmp/ulixops-src001.sql"]),
    );
    expect(phases).toEqual(
      expect.arrayContaining(["checking", "safety", "database", "files", "finishing"]),
    );
  });

  it("restores only the database, stopping the download once tar has the dump", async () => {
    const { drive } = driveWithBackup();
    const s = site({ readDbOnly: true });
    const r = await runFullRestore(s.session, target, job({ scope: "DATABASE" }), "k", {
      vault: vault(),
      fetchImpl: drive.fetch,
      sleep: noSleep,
    });
    expect(r).toMatchObject({ ok: true, database: true, files: false });
    expect(r.detail).toBe("Restored the database from the backup.");
    expect(s.calls.some((c) => c.includes("--no-overwrite-dir"))).toBe(false);
    expect(s.stdin.files).toBeUndefined();
  });

  it("restores only wp-content, leaving the database alone", async () => {
    const { drive } = driveWithBackup();
    const s = site();
    const r = await runFullRestore(s.session, target, job({ scope: "FILES" }), "k", {
      vault: vault(),
      fetchImpl: drive.fetch,
      sleep: noSleep,
    });
    expect(r).toMatchObject({ ok: true, database: false, files: true });
    expect(s.calls.some((c) => c.includes("db import"))).toBe(false);
    expect(s.calls).toContain(
      "tar -xzf - --no-same-owner --no-overwrite-dir --exclude=ulixops-src001.sql --exclude=./wp-config.php -C /sites/shop ./wp-content",
    );
  });

  it("changes nothing when the backup doesn't open with the current key", async () => {
    const { drive } = driveWithBackup("cd".repeat(32));
    const s = site();
    const r = await runFullRestore(s.session, target, job(), "k", {
      vault: vault(),
      fetchImpl: drive.fetch,
      sleep: noSleep,
    });
    expect(r).toMatchObject({ ok: false, changed: false, safety: null });
    expect(r.detail).toMatch(/current backup key.*Nothing on the site was changed\.$/);
    expect(s.calls).toEqual([]);
  });

  it("changes nothing when the backup is gone from Drive or Drive isn't connected", async () => {
    const { drive } = driveWithBackup();
    drive.files.delete("backup-file-1");
    const gone = await runFullRestore(site().session, target, job(), "k", {
      vault: vault(),
      fetchImpl: drive.fetch,
      sleep: noSleep,
    });
    expect(gone.detail).toMatch(/no longer on Google Drive/);
    const off = await runFullRestore(site().session, target, job(), "k", {
      vault: vault({ GOOGLE_DRIVE_REFRESH_TOKEN: null }),
      fetchImpl: drive.fetch,
      sleep: noSleep,
    });
    expect(off).toMatchObject({ ok: false, changed: false });
    expect(off.detail).toMatch(/isn't connected/);
  });

  it("resumes a dropped download where it stopped", async () => {
    const { drive, archive } = driveWithBackup();
    const s = site();
    let downloads = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      // The key check (1st) and the database pass (2nd) read normally; the files pass drops.
      if (url.includes("alt=media") && ++downloads === 3) drive.dropDownloadAfter = 100_000;
      return drive.fetch(input, init);
    };
    const r = await runFullRestore(s.session, target, job(), "k", {
      vault: vault(),
      fetchImpl,
      sleep: noSleep,
    });
    expect(r.ok).toBe(true);
    expect(s.stdin.files).toEqual(archive);
    expect(drive.downloads.at(-1)).toBe("bytes=100000-");
  });

  it("reports a failed import as a partial change, and keeps secrets out", async () => {
    const { drive } = driveWithBackup();
    const s = site({ importExit: 1 });
    const r = await runFullRestore(s.session, target, job(), "k", {
      vault: vault(),
      fetchImpl: drive.fetch,
      sleep: noSleep,
    });
    expect(r).toMatchObject({ ok: false, changed: true, database: false, files: false });
    expect(r.safety).not.toBeNull();
    expect(r.detail).toMatch(/database import failed.*restore the safety copy to undo\.$/);
    expect(JSON.stringify(r)).not.toContain("1//refreshTOKENvalue");
    // Maintenance mode is switched off again whatever happened.
    expect(s.calls.at(-1)).toMatch(/maintenance-mode deactivate/);
  });

  it("accepts files the host keeps read-only as warnings, but not a broken archive", async () => {
    const { drive } = driveWithBackup();
    const readOnly = await runFullRestore(
      site({
        filesExit: 2,
        filesStderr:
          "tar: ./wp-content/mu-plugins/wpengine-common/a.php: Cannot open: Permission denied\ntar: Exiting with failure status due to previous errors\n",
      }).session,
      target,
      job(),
      "k",
      { vault: vault(), fetchImpl: drive.fetch, sleep: noSleep },
    );
    expect(readOnly).toMatchObject({ ok: true, files: true });
    expect(readOnly.warnings).toHaveLength(1);
    expect(readOnly.detail).toMatch(/1 file the host keeps read-only couldn't be replaced/);

    const broken = await runFullRestore(
      site({ filesExit: 2, filesStderr: "gzip: stdin: unexpected end of file\n" }).session,
      target,
      job(),
      "k",
      { vault: vault(), fetchImpl: drive.fetch, sleep: noSleep },
    );
    expect(broken).toMatchObject({ ok: false, changed: true, database: true, files: false });
    expect(broken.detail).toMatch(/Extracting the files failed/);
  });

  it("stops before touching the site when the safety copy fails", async () => {
    const { drive } = driveWithBackup();
    const s = site();
    s.session.execStream = async () => ({ exitCode: 2, stderr: "tar: disk full", stopped: false });
    const r = await runFullRestore(s.session, target, job(), "k", {
      vault: vault(),
      fetchImpl: drive.fetch,
      sleep: noSleep,
    });
    expect(r).toMatchObject({ ok: false, changed: false, safety: null });
    expect(r.detail).toMatch(/^The safety copy failed, so nothing was restored/);
    expect(s.calls.some((c) => c.includes("maintenance-mode"))).toBe(false);
    expect(s.calls.some((c) => c.startsWith("tar -xzf"))).toBe(false);
  });

  it("copies production into staging: checks prefixes, then changes the site address (A157)", async () => {
    const { drive } = driveWithBackup();
    const s = site();
    const r = await runFullRestore(
      s.session,
      target,
      job({
        scope: "DATABASE",
        rewrite: { from: "shop.example", to: "shopstg.wpenginepowered.com" },
      }),
      "k",
      { vault: vault(), fetchImpl: drive.fetch, sleep: noSleep },
    );
    expect(r).toMatchObject({ ok: true, database: true });
    expect(r.detail).toContain("changed from shop.example to shopstg.wpenginepowered.com");
    const replaces = s.calls.filter((c) => c.includes("search-replace"));
    expect(replaces).toEqual([
      "wp --path=/sites/shop search-replace //shop.example //shopstg.wpenginepowered.com --all-tables-with-prefix --skip-columns=guid --report-changed-only --skip-plugins --skip-themes",
      "wp --path=/sites/shop search-replace \\/\\/shop.example \\/\\/shopstg.wpenginepowered.com --all-tables-with-prefix --skip-columns=guid --report-changed-only --skip-plugins --skip-themes",
    ]);
    // Prefix check before the import, address change after it.
    const order = (needle: string) => s.calls.findIndex((c) => c.includes(needle));
    expect(order("db prefix")).toBeLessThan(order("db reset"));
    expect(order("db reset")).toBeLessThan(order("db import"));
    expect(order("db import")).toBeLessThan(order("search-replace"));
    expect(r.detail).toMatch(/previous database was cleared first/);
  });

  it("copies staging into production the same way (A174)", async () => {
    const { drive } = driveWithBackup();
    const s = site();
    const r = await runFullRestore(
      s.session,
      target,
      job({
        scope: "ALL",
        rewrite: { from: "shopstg.wpenginepowered.com", to: "shop.example" },
      }),
      "k",
      { vault: vault(), fetchImpl: drive.fetch, sleep: noSleep },
    );
    expect(r).toMatchObject({ ok: true, database: true, files: true });
    expect(r.detail).toContain("changed from shopstg.wpenginepowered.com to shop.example");
    expect(r.detail).toMatch(/previous database, plugins, themes and uploads were removed first/);
    const order = (needle: string) => s.calls.findIndex((c) => c.includes(needle));
    expect(order("db reset")).toBeLessThan(order("db import"));
    expect(order("rm -rf -- /sites/shop/wp-content/plugins")).toBeLessThan(
      order("tar -xzf - --no-same-owner"),
    );
    expect(s.calls.filter((c) => c.includes("search-replace"))[0]).toContain(
      "//shopstg.wpenginepowered.com //shop.example",
    );
  });

  it("refuses another environment's database when the table prefixes differ", async () => {
    const { drive } = driveWithBackup();
    const s = site({ sitePrefix: "wpstg0_" });
    const r = await runFullRestore(
      s.session,
      target,
      job({ scope: "DATABASE", rewrite: { from: "shop.example", to: "stg.example" } }),
      "k",
      { vault: vault(), fetchImpl: drive.fetch, sleep: noSleep },
    );
    expect(r).toMatchObject({ ok: false, changed: false, database: false });
    expect(r.detail).toMatch(
      /start with "wp_" but this site's with "wpstg0_".*Nothing on the site was changed/,
    );
    expect(s.calls.some((c) => c.includes("db import"))).toBe(false);
    expect(s.calls.some((c) => c.includes("db reset"))).toBe(false);
  });

  it("names which prefix check failed when wp db prefix errors (A173)", async () => {
    const { drive } = driveWithBackup();
    const s = site({
      prefixExit: 1,
      prefixStderr: "Error: YIKES: Your version of PHP doesn't meet WP-CLI requirements",
    });
    const r = await runFullRestore(
      s.session,
      target,
      job({ scope: "DATABASE", rewrite: { from: "shop.example", to: "stg.example" } }),
      "k",
      { vault: vault(), fetchImpl: drive.fetch, sleep: noSleep },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Couldn't read this site's table prefix/);
    expect(r.detail).toMatch(/doesn't meet WP-CLI/);
    expect(s.calls.some((c) => c.includes("db import"))).toBe(false);
  });

  it("accepts IF NOT EXISTS in the dump's CREATE TABLE line (A173)", async () => {
    const { drive } = driveWithBackup();
    const s = site({
      dumpCreateLine: "CREATE TABLE IF NOT EXISTS `wp_options`\n",
    });
    const r = await runFullRestore(
      s.session,
      target,
      job({
        scope: "DATABASE",
        rewrite: { from: "shop.example", to: "shopstg.wpenginepowered.com" },
      }),
      "k",
      { vault: vault(), fetchImpl: drive.fetch, sleep: noSleep },
    );
    expect(r).toMatchObject({ ok: true, database: true });
  });
});
