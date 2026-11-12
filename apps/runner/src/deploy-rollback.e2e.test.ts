// E2E: deploy a broken plugin → health fails → restore previous snapshot (TEST_WP_SSH).
// Spec §9 / Build Order step 12. Skipped in CI (no test-wp).
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleJob } from "./jobs";
import { PluginStoreReader } from "./plugin-store";
import { SnapshotStore } from "./snapshot-store";
import { ssh2Connector } from "./ssh";
import { MemoryVault } from "./vault";
import { zipStore } from "./zip";

const [host, port] = (process.env.TEST_WP_SSH ?? "").split(":");
const keyFile = path.resolve(import.meta.dirname, "../../../.dev/ssh/test_wp_ed25519");
const ENC_KEY = "ab".repeat(32);
/** Published port of test-wp on the laptop (runner process here is not inside compose). */
const SITE_ORIGIN = process.env.TEST_WP_URL ?? "http://127.0.0.1:8080";

function buildPluginZip(opts: { slug: string; version: string; broken: boolean }): Buffer {
  // Broken: WP-CLI activate succeeds (WP_CLI defined); HTTP fatals so health fails.
  const php = opts.broken
    ? `<?php
/**
 * Plugin Name: UlixOps E2E Broken
 * Version: ${opts.version}
 */
if (!defined('ABSPATH')) { exit; }
if (!(defined('WP_CLI') && WP_CLI)) {
  ulixops_e2e_undefined_function();
}
`
    : `<?php
/**
 * Plugin Name: UlixOps E2E Probe
 * Version: ${opts.version}
 */
if (!defined('ABSPATH')) { exit; }
`;
  return zipStore(new Map([[`${opts.slug}/${opts.slug}.php`, Buffer.from(php, "utf8")]]));
}

describe.runIf(host && port)(
  "deploy → fail health → rollback (real SSH)",
  { timeout: 180_000 },
  () => {
    const vault = new MemoryVault();
    const snapRoot = mkdtempSync(path.join(tmpdir(), "ulixops-e2e-snap-"));
    const pluginRoot = mkdtempSync(path.join(tmpdir(), "ulixops-e2e-plug-"));
    const snapshots = new SnapshotStore(snapRoot);
    const plugins = new PluginStoreReader(pluginRoot);
    let hostKey: string | null = null;
    const slug = "ulixops-e2e-probe";

    beforeAll(() => {
      vault.secrets.set("SSH_KEY_TEST_WP", {
        value: readFileSync(keyFile, "utf8"),
        at: new Date().toISOString(),
      });
      mkdirSync(path.join(pluginRoot, "versions"), { recursive: true });
    });
    afterAll(() => {
      rmSync(snapRoot, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    });

    const target = () => ({
      host: host ?? "",
      port: Number(port),
      user: "wpdev",
      wpPath: "/var/www/html",
      credentialRef: "SSH_KEY_TEST_WP",
      hostKey,
    });
    const deps = () => ({
      vault,
      ssh: ssh2Connector,
      snapshots: { store: snapshots, encryptionKey: ENC_KEY },
      plugins,
    });

    function storeZip(zip: Buffer) {
      const sha256 = createHash("sha256").update(zip).digest("hex");
      writeFileSync(path.join(pluginRoot, "versions", `${sha256}.zip`), zip);
      return { storageKey: `versions/${sha256}.zip` as const, sha256 };
    }

    async function health(): Promise<boolean> {
      const result = (await handleJob(
        {
          type: "site.health",
          target: target(),
          urls: [`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/wp-admin/`],
          origin: SITE_ORIGIN,
          thresholdMs: 10_000,
          checkErrorLog: false,
        },
        deps(),
      )) as { ok: boolean };
      return result.ok;
    }

    it("installs a healthy plugin, then rolls back a broken deploy after health fails", async () => {
      const tested = (await handleJob({ type: "site.test", target: target() }, deps())) as {
        ok: boolean;
        hostKey: string;
      };
      expect(tested.ok).toBe(true);
      hostKey = tested.hostKey;

      await handleJob(
        {
          type: "remote.command",
          target: target(),
          command: { op: "plugin.deactivate", slug, safe: true },
        },
        deps(),
      );

      const good = storeZip(buildPluginZip({ slug, version: "1.0.0", broken: false }));
      const backupEmpty = randomUUID().replace(/-/g, "").slice(0, 24);
      expect(
        (
          (await handleJob(
            {
              type: "site.snapshot",
              target: target(),
              backupId: backupEmpty,
              plugin: slug,
              includeDb: false,
            },
            deps(),
          )) as { ok: boolean }
        ).ok,
      ).toBe(true);

      expect(
        (
          (await handleJob(
            {
              type: "site.plugin.deploy",
              target: target(),
              plugin: slug,
              storageKey: good.storageKey,
              sha256: good.sha256,
            },
            deps(),
          )) as { ok: boolean }
        ).ok,
      ).toBe(true);
      expect(await health()).toBe(true);

      const beforeBroken = randomUUID().replace(/-/g, "").slice(0, 24);
      const snapshot = (await handleJob(
        {
          type: "site.snapshot",
          target: target(),
          backupId: beforeBroken,
          plugin: slug,
          includeDb: false,
        },
        deps(),
      )) as { ok: boolean; location: string | null };
      expect(snapshot.ok).toBe(true);
      // Content-addressed blobs (A103) are found by location, not by backup id.
      expect(snapshot.location).toMatch(/^quick\//);

      const bad = storeZip(buildPluginZip({ slug, version: "2.0.0-broken", broken: true }));
      expect(
        (
          (await handleJob(
            {
              type: "site.plugin.deploy",
              target: target(),
              plugin: slug,
              storageKey: bad.storageKey,
              sha256: bad.sha256,
            },
            deps(),
          )) as { ok: boolean }
        ).ok,
      ).toBe(true);
      expect(await health()).toBe(false);

      expect(
        (
          (await handleJob(
            {
              type: "site.snapshot.restore",
              target: target(),
              backupId: beforeBroken,
              plugin: slug,
              includesDb: false,
              location: snapshot.location ?? undefined,
            },
            deps(),
          )) as { ok: boolean }
        ).ok,
      ).toBe(true);
      expect(await health()).toBe(true);
    });
  },
);
