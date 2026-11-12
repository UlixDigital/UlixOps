// Parsers and flow for `site.integrity` (A144), using output captured from WP-CLI 2.12.
import type { ExecResult } from "@ulixops/shared";
import { describe, expect, it } from "vitest";
import { parseCoreOutput, parsePluginOutput, runIntegrityCheck } from "./integrity";
import type { SshSession } from "./ssh";

const CORE_CHANGED = `Warning: File doesn't verify against checksum: wp-includes/version.php
Warning: File doesn't exist: wp-includes/class-wp-error.php
Warning: File should not exist: wp-config-docker.php
Warning: File should not exist: wp-includes/evil-x.php
Error: WordPress installation doesn't verify against checksums.`;

const PLUGINS_JSON =
  '[{"plugin_name":"akismet","file":"akismet.php","message":"Checksum does not match"},{"plugin_name":"akismet","file":"added.php","message":"File was added"}]';
const PLUGINS_STDERR = `Warning: Couldn't fetch response from https://downloads.wordpress.org/plugin-checksums/elementor-pro/3.1.0.json (HTTP code 404).
Warning: Could not retrieve the checksums for version 3.1.0 of plugin elementor-pro, skipping.
Error: Only verified 1 of 3 plugins (1 failed, 1 skipped).`;

const target = {
  host: "site.example.test",
  port: 22,
  user: "wp",
  wpPath: "/sites/shop",
  credentialRef: "SHOP_SSH_KEY",
  hostKey: null,
};

function session(core: Partial<ExecResult>, plugins: Partial<ExecResult>) {
  const calls: string[] = [];
  const s: SshSession = {
    hostKey: `SHA256:${"A".repeat(43)}`,
    exec: async (argv) => {
      calls.push(argv.join(" "));
      const out = argv.includes("core") ? core : plugins;
      return { exitCode: 0, stdout: "", stderr: "", ...out };
    },
    sftp: async () => {
      throw new Error("unused");
    },
    close: () => undefined,
  };
  return { s, calls };
}

describe("integrity parsers", () => {
  it("reads core warnings", () => {
    expect(parseCoreOutput(CORE_CHANGED)).toEqual([
      { scope: "core", component: "wordpress", path: "wp-includes/version.php", issue: "modified" },
      {
        scope: "core",
        component: "wordpress",
        path: "wp-includes/class-wp-error.php",
        issue: "missing",
      },
      { scope: "core", component: "wordpress", path: "wp-config-docker.php", issue: "added" },
      { scope: "core", component: "wordpress", path: "wp-includes/evil-x.php", issue: "added" },
    ]);
  });

  it("reads plugin JSON, skipped plugins and counts", () => {
    const parsed = parsePluginOutput(`PHP Notice: noise\n${PLUGINS_JSON}`, PLUGINS_STDERR);
    expect(parsed.findings).toEqual([
      {
        scope: "plugin",
        component: "akismet",
        path: "akismet.php",
        issue: "modified",
      },
      {
        scope: "plugin",
        component: "akismet",
        path: "added.php",
        issue: "added",
      },
    ]);
    expect(parsed.unverifiable).toEqual(["elementor-pro"]);
    expect(parsed.verified).toBe(2);
    // All well: the summary comes on stdout and there is no JSON at all.
    expect(parsePluginOutput("Success: Verified 2 of 4 plugins (2 skipped).", "").verified).toBe(2);
  });
});

describe("runIntegrityCheck", () => {
  it("combines core and plugin results", async () => {
    const { s, calls } = session(
      { exitCode: 1, stderr: CORE_CHANGED },
      { exitCode: 1, stdout: PLUGINS_JSON, stderr: PLUGINS_STDERR },
    );
    const r = await runIntegrityCheck(s, target, "k");
    expect(calls).toEqual([
      "wp --path=/sites/shop core verify-checksums",
      "wp --path=/sites/shop plugin verify-checksums --all --format=json --skip-plugins --skip-themes",
    ]);
    expect(r).toMatchObject({
      coreChecked: true,
      pluginsChecked: true,
      verifiedPlugins: 2,
      unverifiable: ["elementor-pro"],
    });
    expect(r.findings).toHaveLength(6);
    expect(r.detail).toContain("WordPress core: 4 files differ.");
    expect(r.detail).toContain("1 not on WordPress.org");
  });

  it("keeps core results when WordPress can't load for the plugin check", async () => {
    const { s } = session(
      { exitCode: 1, stderr: CORE_CHANGED },
      { exitCode: 255, stderr: "PHP Fatal error: Uncaught Error SECRETKEY" },
    );
    const r = await runIntegrityCheck(s, target, "SECRETKEY");
    expect(r).toMatchObject({ coreChecked: true, pluginsChecked: false, unverifiable: [] });
    expect(r.findings.every((f) => f.scope === "core")).toBe(true);
    expect(r.detail).toContain("Plugins couldn't be checked (exit 255)");
    expect(r.detail).not.toContain("SECRETKEY");
  });

  it("reports a clean site and a core check that couldn't run", async () => {
    const clean = await runIntegrityCheck(
      session(
        { stderr: "Success: WordPress installation verifies against checksums." },
        { stdout: "[]", stderr: "Success: Verified 3 of 3 plugins." },
      ).s,
      target,
      "k",
    );
    expect(clean).toMatchObject({ coreChecked: true, pluginsChecked: true, findings: [] });
    const broken = await runIntegrityCheck(
      session(
        { exitCode: 127, stderr: "wp: not found" },
        { exitCode: 127, stderr: "wp: not found" },
      ).s,
      target,
      "k",
    );
    expect(broken).toMatchObject({ coreChecked: false, pluginsChecked: false });
  });
});
