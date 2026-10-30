// Real SSH against the local test WordPress container (TEST_WP_SSH=host:port, dev key in .dev/).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { handleJob } from "./jobs";
import { SnapshotStore } from "./snapshot-store";
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
  const inventory = () =>
    handleJob({ type: "site.inventory", target }, deps) as Promise<{
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
      const broken = await inventory();
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
      )) as { ok: boolean; sha256: string | null; sizeBytes: number | null; detail: string };
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
        },
        snapDeps,
      )) as { ok: boolean; detail: string };
      expect(restored.ok).toBe(true);
      expect(restored.detail).toMatch(/Restored hello/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
