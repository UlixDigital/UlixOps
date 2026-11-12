// `site.errorlog` (A159/A167): prefer UlixOps private log, else debug.log.
import type { SshTarget } from "@ulixops/shared";
import { describe, expect, it } from "vitest";
import { readErrorLog } from "./errorlog";
import type { SshSession } from "./ssh";

const target: SshTarget = {
  host: "shop.ssh.example.test",
  port: 22,
  user: "shop",
  wpPath: "/sites/shop/",
  credentialRef: "SHOP_KEY",
  hostKey: null,
};
const SECRET =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretkeymaterial1234567890\n-----END OPENSSH PRIVATE KEY-----";
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

function session(files: Record<string, { text: string; size?: number }>) {
  const read: string[] = [];
  const s = {
    hostKey: `SHA256:${"B".repeat(43)}`,
    exec: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error: The constant 'WP_DEBUG' is not defined in the 'wp-config.php' file.",
    }),
    sftp: async () => ({
      stat: async (p: string) => {
        read.push(`stat ${p}`);
        const f = files[p];
        return f ? { isDirectory: false, size: f.size ?? f.text.length } : null;
      },
      readFileTail: async (p: string, max: number) => {
        read.push(`tail ${p} ${max}`);
        return Buffer.from(files[p]?.text ?? "");
      },
      writeFile: async () => undefined,
      close: () => undefined,
    }),
    close: () => undefined,
  } as unknown as SshSession;
  return { s, read };
}

describe("readErrorLog", () => {
  it("says when there is no log file", async () => {
    const { s, read } = session({});
    expect(await readErrorLog(s, target, SECRET, () => NOW)).toMatchObject({
      debug: {
        WP_DEBUG: null,
        WP_DEBUG_LOG: null,
        WP_DEBUG_DISPLAY: null,
      },
      pluginInstalled: false,
      logSource: "none",
      fileFound: false,
      sizeBytes: 0,
      groups: [],
    });
    expect(read.some((r) => r.includes("ulixops-logs"))).toBe(true);
  });

  it("prefers the UlixOps private log when the mu-plugin is installed", async () => {
    const text = `[01-Nov-2026 11:00:00 UTC] PHP Fatal error:  boom in /sites/shop/wp-content/plugins/x/a.php:1`;
    const { s, read } = session({
      "/sites/shop/wp-content/mu-plugins/ulixops-error-log.php": { text: "<?php" },
      "/sites/shop/wp-content/ulixops-logs/php-errors.php": { text },
    });
    const r = await readErrorLog(s, target, SECRET, () => NOW);
    expect(r.logSource).toBe("ulixops");
    expect(r.pluginInstalled).toBe(true);
    expect(read).toContain("tail /sites/shop/wp-content/ulixops-logs/php-errors.php 524288");
    expect(r.groups[0]).toMatchObject({ level: "fatal", count24h: 1 });
  });

  it("falls back to debug.log and redacts secrets", async () => {
    const text = [
      "cut off line from the middle",
      `[01-Nov-2026 11:00:00 UTC] PHP Fatal error:  Uncaught Exception: key AAAAsecretkeymaterial1234567890 in /home/wpe-user/sites/shop/wp-content/plugins/shop-sync/sync.php:9`,
    ].join("\n");
    const { s, read } = session({
      "/sites/shop/wp-content/debug.log": { text, size: 5_000_000 },
    });
    const r = await readErrorLog(s, target, SECRET, () => NOW);
    expect(read).toContain("tail /sites/shop/wp-content/debug.log 524288");
    expect(r).toMatchObject({
      logSource: "debug.log",
      pluginInstalled: false,
      fileFound: true,
      truncated: true,
    });
    expect(r.groups[0]).toMatchObject({ level: "fatal", source: "plugin:shop-sync" });
    expect(JSON.stringify(r)).not.toContain("AAAAsecretkeymaterial1234567890");
  });
});
