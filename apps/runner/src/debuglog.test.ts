// PHP error logging switch (A167): install/remove UlixOps mu-plugin + private log.
import type { SshTarget } from "@ulixops/shared";
import {
  ULIXOPS_ERROR_LOG_HEADER,
  ULIXOPS_ERROR_LOG_PLUGIN_SOURCE,
  ulixopsErrorLogPluginPath,
} from "@ulixops/shared";
import { describe, expect, it } from "vitest";
import { muPluginInstalled, switchDebugLog } from "./debuglog";
import type { SshSession } from "./ssh";

const target: SshTarget = {
  host: "shop.ssh.example.test",
  port: 22,
  user: "shop",
  wpPath: "/sites/shop",
  credentialRef: "SHOP_KEY",
  hostKey: null,
};

function site() {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  const session = {
    hostKey: `SHA256:${"B".repeat(43)}`,
    exec: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error: The constant 'WP_DEBUG' is not defined in the 'wp-config.php' file.",
    }),
    sftp: async () => ({
      stat: async (p: string) => {
        if (dirs.has(p)) return { isDirectory: true, size: 0 };
        if (files.has(p)) return { isDirectory: false, size: files.get(p)?.length ?? 0 };
        return null;
      },
      writeFile: async (p: string, d: Buffer) => {
        files.set(p, d);
      },
      mkdirp: async (p: string) => {
        dirs.add(p);
      },
      unlink: async (p: string) => {
        files.delete(p);
      },
      readFile: async (p: string, max = 64 * 1024) => {
        const b = files.get(p) ?? Buffer.alloc(0);
        if (b.length > max) throw new Error(`Remote output exceeds ${max} bytes`);
        return b;
      },
      readFileHead: async (p: string, max = 64 * 1024) =>
        (files.get(p) ?? Buffer.alloc(0)).subarray(0, max),
      readFileTail: async (p: string, max = 64 * 1024) => {
        const b = files.get(p) ?? Buffer.alloc(0);
        return b.subarray(Math.max(0, b.length - max));
      },
      close: () => undefined,
    }),
    close: () => undefined,
  } as unknown as SshSession;
  return { session, files, dirs };
}

const web = (exposed: boolean, seen: string[] = []): typeof fetch =>
  (async (url: string | URL | Request) => {
    seen.push(String(url));
    return exposed
      ? new Response("[01-Nov-2026 12:00:00 UTC] UlixOps: PHP error logging switched on\n", {
          status: 200,
        })
      : new Response("Forbidden", { status: 403 });
  }) as typeof fetch;

describe("PHP error logging switch (mu-plugin, A167)", () => {
  it("installs the mu-plugin and private log without editing wp-config", async () => {
    const s = site();
    const seen: string[] = [];
    const r = await switchDebugLog(
      s.session,
      target,
      { action: "enable", siteUrl: "https://shop.example" },
      "secret",
      { fetchImpl: web(false, seen), now: () => Date.UTC(2026, 10, 1, 12, 0, 0) },
    );
    expect(r.ok).toBe(true);
    expect(r.method).toBe("mu-plugin");
    expect(r.pluginInstalled).toBe(true);
    expect(s.files.get(ulixopsErrorLogPluginPath("/sites/shop"))?.toString()).toBe(
      ULIXOPS_ERROR_LOG_PLUGIN_SOURCE,
    );
    const log = s.files.get("/sites/shop/wp-content/ulixops-logs/php-errors.php")?.toString() ?? "";
    expect(log.startsWith("<?php")).toBe(true);
    expect(log).toContain("exit;");
    expect(s.files.has("/sites/shop/wp-content/ulixops-logs/.htaccess")).toBe(true);
    expect(seen[0]).toContain("/wp-content/ulixops-logs/php-errors.php");
  });

  it("treats an empty PHP response as not exposed (nginx executes the exit header)", async () => {
    const s = site();
    const r = await switchDebugLog(
      s.session,
      target,
      { action: "enable", siteUrl: "https://shop.example" },
      "secret",
      {
        fetchImpl: (async () => new Response("", { status: 200 })) as typeof fetch,
        now: () => Date.UTC(2026, 10, 1, 12, 0, 0),
      },
    );
    expect(r.ok).toBe(true);
    expect(r.pluginInstalled).toBe(true);
  });

  it("removes the plugin again if the private log is downloadable", async () => {
    const s = site();
    const r = await switchDebugLog(
      s.session,
      target,
      { action: "enable", siteUrl: "https://shop.example" },
      "secret",
      { fetchImpl: web(true) },
    );
    expect(r.ok).toBe(false);
    expect(r.exposed).toBe(true);
    expect(r.pluginInstalled).toBe(false);
    expect(s.files.has(ulixopsErrorLogPluginPath("/sites/shop"))).toBe(false);
  });

  it("removes the mu-plugin on disable", async () => {
    const s = site();
    await switchDebugLog(
      s.session,
      target,
      { action: "enable", siteUrl: "https://shop.example" },
      "secret",
      { fetchImpl: web(false) },
    );
    expect(await muPluginInstalled(s.session, "/sites/shop")).toBe(true);
    const r = await switchDebugLog(
      s.session,
      target,
      { action: "disable", siteUrl: "https://shop.example" },
      "secret",
      { fetchImpl: web(false) },
    );
    expect(r.ok).toBe(true);
    expect(r.pluginInstalled).toBe(false);
    expect(await muPluginInstalled(s.session, "/sites/shop")).toBe(false);
    // Log file kept for history.
    expect(s.files.has("/sites/shop/wp-content/ulixops-logs/php-errors.php")).toBe(true);
  });

  it("reuses an existing log larger than 96 bytes without Remote output exceeds (A170)", async () => {
    const s = site();
    const body = `${ULIXOPS_ERROR_LOG_HEADER}[01-Nov-2026 12:00:00 UTC] UlixOps: PHP error logging switched on\n`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(96);
    s.files.set("/sites/shop/wp-content/ulixops-logs/php-errors.php", Buffer.from(body));
    const r = await switchDebugLog(
      s.session,
      target,
      { action: "enable", siteUrl: "https://shop.example" },
      "secret",
      { fetchImpl: web(false), now: () => Date.UTC(2026, 10, 1, 12, 0, 0) },
    );
    expect(r.ok).toBe(true);
    expect(r.pluginInstalled).toBe(true);
  });

  it("deletes a leftover public php-errors.log from A167", async () => {
    const s = site();
    s.files.set(
      "/sites/shop/wp-content/ulixops-logs/php-errors.log",
      Buffer.from("[01-Nov-2026 12:00:00 UTC] UlixOps: PHP error logging switched on\n"),
    );
    await switchDebugLog(
      s.session,
      target,
      { action: "enable", siteUrl: "https://shop.example" },
      "secret",
      { fetchImpl: web(false), now: () => Date.UTC(2026, 10, 1, 12, 0, 0) },
    );
    expect(s.files.has("/sites/shop/wp-content/ulixops-logs/php-errors.log")).toBe(false);
    expect(s.files.has("/sites/shop/wp-content/ulixops-logs/php-errors.php")).toBe(true);
  });
});
