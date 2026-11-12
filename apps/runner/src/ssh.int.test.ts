// Real SSH against the local test WordPress container (TEST_WP_SSH=host:port, dev key in .dev/).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { decryptBackup } from "./backup-crypto";
import { runFullBackup } from "./full-backup";
import { runFullRestore } from "./full-restore";
import { handleJob } from "./jobs";
import { runMalwareScan } from "./malware-scan";
import { SnapshotStore } from "./snapshot-store";
import { unpackTar } from "./tar";
import { FakeDrive } from "./testing/fake-drive";
import { ssh2Connector } from "./ssh";
import { MemoryVault } from "./vault";

const [host, port] = (process.env.TEST_WP_SSH ?? "").split(":");
const keyFile = path.resolve(import.meta.dirname, "../../../.dev/ssh/test_wp_ed25519");

describe.runIf(host && port)("SSH to the local test site", { timeout: 60_000 }, () => {
  const vault = new MemoryVault();
  // Read only when the suite runs: the key exists only where the test site was set up.
  beforeAll(() => {
    vault.secrets.set("SSH_KEY_TEST_WP", {
      value: readFileSync(keyFile, "utf8"),
      at: new Date().toISOString(),
    });
  });
  const target = {
    host: host ?? "",
    port: Number(port),
    user: "wpdev",
    wpPath: "/var/www/html",
    credentialRef: "SSH_KEY_TEST_WP",
    hostKey: null,
  };
  const deps = { vault, ssh: ssh2Connector };

  it("passes Test connection and pins the host key", async () => {
    const result = (await handleJob({ type: "site.test", target }, deps)) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({ ok: true, hostKeyMismatch: false, wpCliVersion: "2.12.0" });
    expect(result.wpVersion).toMatch(/^\d+\.\d+/);
    expect(result.phpVersion).toMatch(/^8\./);
    expect(result.hostKey).toMatch(/^SHA256:/);

    const again = (await handleJob(
      { type: "site.test", target: { ...target, hostKey: result.hostKey } },
      deps,
    )) as {
      ok: boolean;
    };
    expect(again.ok).toBe(true);
  });

  it("refuses a server whose host key doesn't match the pinned one", async () => {
    const wrong = `SHA256:${"A".repeat(43)}`;
    const result = await handleJob(
      { type: "site.test", target: { ...target, hostKey: wrong } },
      deps,
    );
    expect(result).toMatchObject({
      ok: false,
      hostKeyMismatch: true,
      steps: [{ name: "vault" }, { name: "ssh", ok: false }],
    });
  });

  it("runs an allowlisted command", async () => {
    const result = (await handleJob(
      { type: "remote.command", target, command: { op: "plugin.list" } },
      deps,
    )) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "hello" })]),
    );
  });

  const command = (c: object) =>
    handleJob({ type: "remote.command", target, command: c }, deps) as Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  const inventory = (checkUpdates?: boolean) =>
    handleJob({ type: "site.inventory", target, checkUpdates }, deps) as Promise<{
      safeMode: boolean;
      maintenance: boolean | null;
      wpVersion: string;
      plugins: { name: string; status: string }[];
      themes: { name: string; status: string }[];
    }>;
  const statusOf = (inv: Awaited<ReturnType<typeof inventory>>, name: string) =>
    inv.plugins.find((p) => p.name === name)?.status;

  it("reads the inventory", async () => {
    const inv = await inventory();
    expect(inv.safeMode).toBe(false);
    expect(inv.maintenance).toBe(false);
    expect(inv.wpVersion).toMatch(/^\d+\.\d+/);
    expect(inv.plugins.map((p) => p.name)).toEqual(
      expect.arrayContaining(["akismet", "hello", "ulixops-broken-fixture"]),
    );
    expect(inv.themes.some((t) => t.status === "active")).toBe(true);
  });

  it("activates and deactivates a plugin", async () => {
    expect((await command({ op: "plugin.activate", slug: "hello" })).exitCode).toBe(0);
    expect(statusOf(await inventory(), "hello")).toBe("active");
    expect((await command({ op: "plugin.deactivate", slug: "hello" })).exitCode).toBe(0);
    expect(statusOf(await inventory(), "hello")).toBe("inactive");
  });

  it("still works when a plugin crashes the site (emergency deactivate)", async () => {
    // The fixture activates cleanly, then crashes every later request, WP-CLI included.
    expect(
      (await command({ op: "plugin.activate", slug: "ulixops-broken-fixture" })).exitCode,
    ).toBe(0);
    try {
      expect((await command({ op: "plugin.deactivate", slug: "hello" })).exitCode).not.toBe(0);
      // Fast refresh never loads plugin code (A114), so it reads the broken site as is.
      const fast = await inventory();
      expect(fast.safeMode).toBe(false);
      expect(statusOf(fast, "ulixops-broken-fixture")).toBe("active");
      // Check for updates loads plugins first, then falls back to safe mode (A54).
      const broken = await inventory(true);
      expect(broken.safeMode).toBe(true);
      expect(statusOf(broken, "ulixops-broken-fixture")).toBe("active");
    } finally {
      const fixed = await command({
        op: "plugin.deactivate",
        slug: "ulixops-broken-fixture",
        safe: true,
      });
      expect(fixed.exitCode).toBe(0);
    }
    const inv = await inventory();
    expect(inv.safeMode).toBe(false);
    expect(statusOf(inv, "ulixops-broken-fixture")).toBe("inactive");
  });

  it("turns maintenance mode on and off and flushes the cache", async () => {
    expect((await command({ op: "maintenance", on: true })).exitCode).toBe(0);
    try {
      expect((await inventory()).maintenance).toBe(true);
    } finally {
      expect((await command({ op: "maintenance", on: false })).exitCode).toBe(0);
    }
    expect((await inventory()).maintenance).toBe(false);
    expect((await command({ op: "cache.flush" })).exitCode).toBe(0);
  });

  it("fails cleanly with a key the server doesn't accept", async () => {
    const other = new MemoryVault();
    const { utils } = await import("ssh2");
    other.secrets.set("SSH_KEY_TEST_WP", {
      value: utils.generateKeyPairSync("ed25519").private,
      at: "",
    });
    const result = await handleJob(
      { type: "site.test", target },
      { vault: other, ssh: ssh2Connector },
    );
    expect(result).toMatchObject({
      ok: false,
      steps: [
        { name: "vault", ok: true },
        { name: "ssh", ok: false },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it("takes a quick snapshot of a plugin and restores it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulixops-snap-ssh-"));
    const key = "ab".repeat(32);
    const snapshots = { store: new SnapshotStore(dir), encryptionKey: key };
    const snapDeps = { vault, ssh: ssh2Connector, snapshots };
    const backupId = "testsnap001";
    try {
      const captured = (await handleJob(
        {
          type: "site.snapshot",
          target,
          backupId,
          plugin: "hello",
          includeDb: false,
        },
        snapDeps,
      )) as {
        ok: boolean;
        sha256: string | null;
        sizeBytes: number | null;
        location: string | null;
        detail: string;
      };
      expect(captured.ok).toBe(true);
      expect(captured.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(captured.sizeBytes).toBeGreaterThan(0);

      const restored = (await handleJob(
        {
          type: "site.snapshot.restore",
          target,
          backupId,
          plugin: "hello",
          includesDb: false,
          // Content-addressed blobs (A103) are found by location, not by backup id.
          location: captured.location ?? undefined,
        },
        snapDeps,
      )) as { ok: boolean; detail: string };
      expect(restored.ok).toBe(true);
      expect(restored.detail).toMatch(/Restored hello/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes an inactive plugin and brings it back from its snapshot (A137)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulixops-del-ssh-"));
    const snapDeps = {
      vault,
      ssh: ssh2Connector,
      snapshots: { store: new SnapshotStore(dir), encryptionKey: "cd".repeat(32) },
    };
    try {
      expect(statusOf(await inventory(), "hello")).toBe("inactive");
      const captured = (await handleJob(
        {
          type: "site.snapshot",
          target,
          backupId: "testdel001",
          plugin: "hello",
          includeDb: false,
        },
        snapDeps,
      )) as { ok: boolean; location: string | null };
      expect(captured.ok).toBe(true);

      expect((await command({ op: "plugin.delete", slug: "hello" })).exitCode).toBe(0);
      expect(statusOf(await inventory(), "hello")).toBeUndefined();

      const restored = (await handleJob(
        {
          type: "site.snapshot.restore",
          target,
          backupId: "testdel001",
          plugin: "hello",
          includesDb: false,
          location: captured.location ?? undefined,
        },
        snapDeps,
      )) as { ok: boolean };
      expect(restored.ok).toBe(true);
      expect(statusOf(await inventory(), "hello")).toBe("inactive");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies the WordPress code for a malware scan, leaving media out (A138)", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "ulixops-scan-ssh-"));
    const session = await ssh2Connector.connect(target, readFileSync(keyFile, "utf8"));
    const copied: string[] = [];
    try {
      // Stand-in for the scanner sidecar: look at the copy, then report one finding.
      const scanner = async () => {
        for (const id of readdirSync(workDir)) {
          const dir = path.join(workDir, id);
          if (!existsSync(path.join(dir, "ready"))) continue;
          copied.push(...readdirSync(path.join(dir, "files")));
          expect(existsSync(path.join(dir, "files", "wp-includes", "version.php"))).toBe(true);
          writeFileSync(
            path.join(dir, "result.csv"),
            `filename,signature_id,signature_name,signature_description\n${dir}/files/wp-config.php,1,Test.Sig,stand-in\n`,
          );
          writeFileSync(path.join(dir, "engines"), "clamav yara\n");
          writeFileSync(path.join(dir, "done"), "0\n");
        }
      };
      const result = await runMalwareScan(session, target, "testscan001", "", {
        workDir,
        pollMs: 1,
        sleep: scanner,
      });
      expect(result).toMatchObject({
        ok: true,
        truncated: false,
        findings: [{ path: "wp-config.php", signatureName: "Test.Sig" }],
      });
      expect(result.files).toBeGreaterThan(500);
      expect(copied).toEqual(expect.arrayContaining(["wp-admin", "wp-content", "wp-includes"]));
      expect(readdirSync(workDir)).toEqual([]);
    } finally {
      session.close();
      rmSync(workDir, { recursive: true, force: true });
    }
    // Streams the whole site over SSH; slow on a busy dev machine.
  }, 300_000);

  it("finds changed core and plugin files, then a clean site again (A144)", async () => {
    const check = () =>
      handleJob({ type: "site.integrity", target }, deps) as Promise<{
        coreChecked: boolean;
        pluginsChecked: boolean;
        findings: { scope: string; component: string; path: string; issue: string }[];
        unverifiable: string[];
      }>;
    const sh = (argv: string[]) =>
      ssh2Connector.connect(target, readFileSync(keyFile, "utf8")).then(async (s) => {
        try {
          return await s.exec(argv);
        } finally {
          s.close();
        }
      });
    const core = "/var/www/html/wp-includes/version.php";
    const plugin = "/var/www/html/wp-content/plugins/hello.php";
    await sh(["cp", core, "/tmp/ulixops-int-version.php"]);
    await sh(["cp", plugin, "/tmp/ulixops-int-hello.php"]);
    try {
      await sh(["sh", "-c", `echo '// x' >> ${core} && echo '// x' >> ${plugin}`]);
      const changed = await check();
      expect(changed).toMatchObject({ coreChecked: true, pluginsChecked: true });
      expect(changed.findings).toEqual(
        expect.arrayContaining([
          {
            scope: "core",
            component: "wordpress",
            path: "wp-includes/version.php",
            issue: "modified",
          },
          { scope: "plugin", component: "hello", path: "hello.php", issue: "modified" },
        ]),
      );
      expect(changed.unverifiable).toEqual(expect.arrayContaining(["ulixops-broken-fixture"]));
    } finally {
      await sh(["cp", "/tmp/ulixops-int-version.php", core]);
      await sh(["cp", "/tmp/ulixops-int-hello.php", plugin]);
    }
    const after = await check();
    expect(after.findings.filter((f) => f.issue === "modified")).toEqual([]);
  }, 300_000);

  it("backs up the whole site and database, encrypted, and cleans up the dump (A145)", async () => {
    const session = await ssh2Connector.connect(target, readFileSync(keyFile, "utf8"));
    const drive = new FakeDrive();
    const key = "cd".repeat(32);
    const backupVault = new MemoryVault();
    for (const [k, v] of Object.entries({
      GOOGLE_DRIVE_CLIENT_ID: "cid",
      GOOGLE_DRIVE_CLIENT_SECRET: "secret",
      GOOGLE_DRIVE_REFRESH_TOKEN: "1//rt",
      BACKUP_ENCRYPTION_KEY: key,
    }))
      backupVault.secrets.set(k, { value: v, at: new Date().toISOString() });
    try {
      const r = await runFullBackup(
        session,
        target,
        {
          backupId: "intbk001",
          folderKey: "intenv",
          folderName: "Test WP (production)",
          fileStem: "test-wp-production",
          oldFileIds: [],
        },
        "",
        { vault: backupVault, fetchImpl: drive.fetch, sleep: async () => undefined },
      );
      expect(r).toMatchObject({ ok: true });
      const data = drive.files.get(r.driveFileId ?? "")?.data ?? Buffer.alloc(0);
      const files = unpackTar(gunzipSync(decryptBackup(data, key)), 100_000, 2_000_000_000);
      const names = new Set(files.map((f) => f.path));
      expect(names.has("ulixops-intbk001.sql")).toBe(true);
      expect(names.has("wp-config.php")).toBe(true);
      expect(names.has("wp-includes/version.php")).toBe(true);
      const sql = files.find((f) => f.path === "ulixops-intbk001.sql")?.data.toString() ?? "";
      expect(sql).toContain("CREATE TABLE");
      expect((await session.exec(["test", "-e", "/tmp/ulixops-intbk001.sql"])).exitCode).not.toBe(
        0,
      );
    } finally {
      session.close();
    }
  }, 300_000);

  it("restores the site from its backup over real SSH, safety copy first (A152)", async () => {
    const session = await ssh2Connector.connect(target, readFileSync(keyFile, "utf8"));
    const drive = new FakeDrive();
    const key = "cd".repeat(32);
    const restoreVault = new MemoryVault();
    for (const [k, v] of Object.entries({
      GOOGLE_DRIVE_CLIENT_ID: "cid",
      GOOGLE_DRIVE_CLIENT_SECRET: "secret",
      GOOGLE_DRIVE_REFRESH_TOKEN: "1//rt",
      BACKUP_ENCRYPTION_KEY: key,
    }))
      restoreVault.secrets.set(k, { value: v, at: new Date().toISOString() });
    const wp = (...args: string[]) => session.exec(["wp", "--path=/var/www/html", ...args]);
    const marker = "/var/www/html/wp-content/uploads/ulixops-int-restore.txt";
    const write = async (text: string) => {
      const fs = await session.sftp();
      await fs.mkdirp("/var/www/html/wp-content/uploads");
      await fs.writeFile(marker, Buffer.from(text));
      fs.close();
    };
    const read = async () => {
      const fs = await session.sftp();
      try {
        return (await fs.readFile(marker)).toString();
      } finally {
        fs.close();
      }
    };
    const tagline = async () => (await wp("option", "get", "blogdescription")).stdout.trim();
    const original = await tagline();
    const opts = { vault: restoreVault, fetchImpl: drive.fetch, sleep: async () => undefined };
    try {
      await wp("option", "update", "blogdescription", "before-restore-test");
      await write("before");
      const backup = await runFullBackup(
        session,
        target,
        {
          backupId: "intrs001",
          folderKey: "intenv",
          folderName: "Test WP (production)",
          fileStem: "test-wp-production",
          oldFileIds: [],
        },
        "",
        opts,
      );
      expect(backup).toMatchObject({ ok: true });
      const job = {
        restoreId: "intrst01",
        driveFileId: backup.driveFileId ?? "",
        sourceBackupId: "intrs001",
        safetyBackupId: "intsafe1",
        folderKey: "intenv",
        folderName: "Test WP (production)",
        fileStem: "test-wp-production",
      };

      // Everything: the file and the database go back.
      await wp("option", "update", "blogdescription", "after-change");
      await write("after");
      const all = await runFullRestore(session, target, { ...job, scope: "ALL" }, "", opts);
      expect(all).toMatchObject({ ok: true, changed: true, database: true, files: true });
      expect(all.safety?.driveFileId).toBeTruthy();
      expect(await tagline()).toBe("before-restore-test");
      expect(await read()).toBe("before");
      // Out of maintenance, and no dump left behind.
      expect((await wp("maintenance-mode", "is-active")).exitCode).not.toBe(0);
      expect((await session.exec(["test", "-e", "/tmp/ulixops-intrs001.sql"])).exitCode).not.toBe(
        0,
      );

      // Database only: the file stays as it is now.
      await wp("option", "update", "blogdescription", "after-again");
      await write("after-again");
      const db = await runFullRestore(
        session,
        target,
        { ...job, safetyBackupId: "intsafe2", scope: "DATABASE" },
        "",
        opts,
      );
      expect(db).toMatchObject({ ok: true, database: true, files: false });
      expect(await tagline()).toBe("before-restore-test");
      expect(await read()).toBe("after-again");
    } finally {
      await wp("option", "update", "blogdescription", original);
      await session.exec(["rm", "-f", marker]);
      session.close();
    }
  }, 600_000);

  it("reads and groups wp-content/debug.log (A159)", async () => {
    const session = await ssh2Connector.connect(target, readFileSync(keyFile, "utf8"));
    const log = "/var/www/html/wp-content/debug.log";
    const sftp = await session.sftp();
    const existed = await sftp.stat(log);
    try {
      if (!existed)
        await sftp.writeFile(
          log,
          Buffer.from(
            "[01-Nov-2026 10:00:00 UTC] PHP Warning:  Undefined variable $x in /var/www/html/wp-content/plugins/hello.php on line 3\n",
          ),
        );
      const result = (await handleJob({ type: "site.errorlog", target }, deps)) as {
        hostKeyMismatch: boolean;
        fileFound: boolean;
        groups: { level: string; source: string | null }[];
      };
      expect(result).toMatchObject({ hostKeyMismatch: false, fileFound: true });
      if (!existed)
        expect(result.groups[0]).toMatchObject({ level: "warning", source: "plugin:hello" });
    } finally {
      if (!existed) await sftp.unlink(log).catch(() => undefined);
      sftp.close();
      session.close();
    }
  });

  it("refuses to delete the active theme", async () => {
    const active = (await inventory()).themes.find((t) => t.status === "active");
    expect(active).toBeDefined();
    const res = await command({ op: "theme.delete", slug: active?.name ?? "" });
    expect(res.exitCode).not.toBe(0);
    expect((await inventory()).themes.find((t) => t.name === active?.name)?.status).toBe("active");
  });
});
