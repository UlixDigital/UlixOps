import type { ExecResult, SshTarget } from "@ulixops/shared";
import ssh2 from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { handleJob } from "./jobs";
import { HostKeyMismatchError, type SshConnector } from "./ssh";
import { MemoryVault } from "./vault";

const KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretmaterialAAAAAAAAAAAAAAAA\n-----END OPENSSH PRIVATE KEY-----";
const target: SshTarget = {
  host: "test-wp",
  port: 22,
  user: "wpdev",
  wpPath: "/var/www/html",
  credentialRef: "SSH_KEY_TEST",
  hostKey: null,
};

function fakeSsh(outputs: Record<string, Partial<ExecResult>>) {
  const exec = vi.fn(async (argv: readonly string[], _timeoutMs?: number): Promise<ExecResult> => {
    const out = outputs[argv.join(" ")] ?? { exitCode: 127, stderr: "not found" };
    return { exitCode: 0, stdout: "", stderr: "", ...out };
  });
  const connect = vi.fn(async () => ({
    hostKey: `SHA256:${"B".repeat(43)}`,
    exec,
    // Inventory checks for a leftover `.maintenance` file (A111); default = absent.
      sftp: vi.fn(async () => ({
      stat: vi.fn(async () => null),
      readFile: vi.fn(),
      readFileHead: vi.fn(),
      readFileTail: vi.fn(),
      writeFile: vi.fn(),
      mkdirp: vi.fn(),
      listDir: vi.fn(async () => []),
      readTree: vi.fn(async () => []),
      writeTree: vi.fn(),
      rename: vi.fn(),
      unlink: vi.fn(),
      rmTree: vi.fn(),
      close: vi.fn(),
    })),
    close: vi.fn(),
  }));
  return { connector: { connect } satisfies SshConnector, exec, connect };
}

function vaultWith(name = "SSH_KEY_TEST", value = KEY) {
  const vault = new MemoryVault();
  vault.secrets.set(name, { value, at: "2026-10-01T00:00:00.000Z" });
  return vault;
}

const FIELDS = "--fields=name,title,status,version,update,update_version";
const FIELDS_FAST = "--fields=name,title,status,version";

const OK_OUTPUTS = {
  "wp --path=/var/www/html cli info --format=json": {
    stdout: '{"wp_cli_version":"2.12.0","php_version":"8.3.36"}',
  },
  "wp --path=/var/www/html core version": { stdout: "7.1.4\n" },
};

describe("runner jobs", () => {
  it("refuses anything that isn't an allowlisted job, before touching the vault or a site", async () => {
    const vault = vaultWith();
    const read = vi.spyOn(vault, "read");
    const { connector, connect } = fakeSsh({});
    for (const data of [
      { type: "shell", cmd: "id" },
      { type: "site.test", target: { ...target, host: "x; id" } },
      "wp",
    ]) {
      await expect(handleJob(data, { vault, ssh: connector })).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("tests a site: vault, SSH, WP-CLI, WordPress and PHP versions", async () => {
    const { connector, connect } = fakeSsh(OK_OUTPUTS);
    const result = await handleJob(
      { type: "site.test", target },
      { vault: vaultWith(), ssh: connector },
    );
    expect(result).toMatchObject({
      ok: true,
      wpVersion: "7.1.4",
      phpVersion: "8.3.36",
      wpCliVersion: "2.12.0",
      hostKey: `SHA256:${"B".repeat(43)}`,
      hostKeyMismatch: false,
    });
    expect(connect).toHaveBeenCalledWith(target, KEY);
    expect(JSON.stringify(result)).not.toContain("secretmaterial");
  });

  it("reports each failing stage clearly", async () => {
    const missing = await handleJob(
      { type: "site.test", target: { ...target, credentialRef: "SSH_KEY_NONE" } },
      { vault: vaultWith(), ssh: fakeSsh({}).connector },
    );
    expect(missing).toMatchObject({ ok: false, steps: [{ name: "vault", ok: false }] });

    const noWp = await handleJob(
      { type: "site.test", target },
      { vault: vaultWith(), ssh: fakeSsh({}).connector },
    );
    expect(noWp).toMatchObject({
      ok: false,
      steps: [{ name: "vault" }, { name: "ssh", ok: true }, { name: "wp-cli", ok: false }],
    });

    const changed: SshConnector = {
      connect: async () => {
        throw new HostKeyMismatchError(`SHA256:${"A".repeat(43)}`, `SHA256:${"C".repeat(43)}`);
      },
    };
    const mitm = await handleJob(
      { type: "site.test", target },
      { vault: vaultWith(), ssh: changed },
    );
    expect(mitm).toMatchObject({
      ok: false,
      hostKeyMismatch: true,
      hostKey: `SHA256:${"C".repeat(43)}`,
    });

    const leaky: SshConnector = {
      connect: async () => {
        throw new Error(`auth failed for key ${KEY}`);
      },
    };
    const failed = await handleJob(
      { type: "site.test", target },
      { vault: vaultWith(), ssh: leaky },
    );
    expect(JSON.stringify(failed)).not.toContain("secretmaterial");
  });

  it("creates an SSH key: private half into the vault, public half returned", async () => {
    const vault = new MemoryVault();
    const result = (await handleJob(
      { type: "credentials.create", name: "SSH_KEY_NEW" },
      { vault, ssh: fakeSsh({}).connector },
    )) as {
      publicKey: string;
    };
    expect(result.publicKey).toMatch(/^ssh-ed25519 \S+ ulixops:SSH_KEY_NEW$/);
    const stored = vault.secrets.get("SSH_KEY_NEW")?.value ?? "";
    expect(stored).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    const parsed = ssh2.utils.parseKey(stored);
    expect(parsed instanceof Error ? null : parsed.type).toBe("ssh-ed25519");
    await expect(
      handleJob(
        { type: "credentials.create", name: "SSH_KEY_NEW" },
        { vault, ssh: fakeSsh({}).connector },
      ),
    ).rejects.toThrow(/already exists/);
  });

  it("lists credentials without values", async () => {
    const result = await handleJob(
      { type: "credentials.list" },
      { vault: vaultWith(), ssh: fakeSsh({}).connector },
    );
    expect(result).toEqual({
      credentials: [
        {
          name: "SSH_KEY_TEST",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("runs an allowlisted command at the site's path and redacts the output", async () => {
    const { connector, exec } = fakeSsh({
      [`wp --path=/var/www/html plugin list --format=json ${FIELDS}`]: { stdout: `[] ${KEY}` },
    });
    const result = await handleJob(
      { type: "remote.command", target, command: { op: "plugin.list" } },
      { vault: vaultWith(), ssh: connector },
    );
    expect(exec).toHaveBeenCalledWith(
      ["wp", "--path=/var/www/html", "plugin", "list", "--format=json", FIELDS],
      60_000,
    );
    expect(result).toMatchObject({
      hostKeyMismatch: false,
      exitCode: 0,
      stdout: "[] [redacted private key]",
    });
  });

  it("gives plugin.update five minutes so large plugins like Elementor can finish (A131)", async () => {
    const { connector, exec } = fakeSsh({
      "wp --path=/var/www/html plugin update elementor": {
        stdout: "Success: Updated 1 of 1 plugins.",
      },
    });
    await handleJob(
      { type: "remote.command", target, command: { op: "plugin.update", slug: "elementor" } },
      { vault: vaultWith(), ssh: connector },
    );
    expect(exec).toHaveBeenCalledWith(
      ["wp", "--path=/var/www/html", "plugin", "update", "elementor"],
      300_000,
    );
  });

  it("answers a changed host key without running anything", async () => {
    const expected = `SHA256:${"A".repeat(43)}`;
    const presented = `SHA256:${"C".repeat(43)}`;
    const connector: SshConnector = {
      connect: vi.fn(async () => {
        throw new HostKeyMismatchError(expected, presented);
      }),
    };
    for (const job of [
      { type: "remote.command", target, command: { op: "cache.flush" } },
      { type: "site.inventory", target },
    ]) {
      await expect(handleJob(job, { vault: vaultWith(), ssh: connector })).resolves.toEqual({
        hostKeyMismatch: true,
        expected,
        presented,
      });
    }
  });

  it("never runs a backup or restore stream as a plain command (A152)", async () => {
    const connector: SshConnector = { connect: vi.fn() };
    for (const command of [
      { op: "backup.archive", wpPath: "/var/www/html", dbFile: "/tmp/ulixops-a.sql" },
      { op: "restore.database", dbFile: "/tmp/ulixops-a.sql" },
      {
        op: "restore.files",
        wpPath: "/var/www/html",
        dbFile: "/tmp/ulixops-a.sql",
        wpContent: false,
      },
      { op: "db.reset" },
      { op: "restore.clear-content", wpPath: "/var/www/html" },
      { op: "db.search-replace", from: "a.example", to: "b.example", escaped: false },
    ])
      await expect(
        handleJob(
          { type: "remote.command", target, command },
          { vault: vaultWith(), ssh: connector },
        ),
      ).rejects.toThrow(/can't run as a plain command/);
    expect(connector.connect).not.toHaveBeenCalled();
  });
});

describe("site inventory", () => {
  const P = "wp --path=/var/www/html";
  const SAFE = "--skip-plugins --skip-themes";
  const plugins = JSON.stringify([
    {
      name: "akismet",
      title: "Akismet",
      status: "active",
      version: "5.3",
      update: "available",
      update_version: "5.4",
    },
    { name: "hello", title: "Hello Dolly", status: "inactive", version: "1.7.2", update: "none" },
    { name: "object-cache.php", title: "", status: "dropin", version: "", update: "none" },
    { name: "weird", title: "", status: "surprise", version: "1", update: "none" },
  ]);
  const themes = JSON.stringify([
    { name: "child", title: "Child", status: "active", version: "1.0", update: "none" },
    { name: "parent", title: "Parent", status: "parent", version: "2.0", update: "available" },
  ]);

  it("fast inventory lists with skip-plugins and without update fields (A114/A115)", async () => {
    const { connector, exec } = fakeSsh({
      ...OK_OUTPUTS,
      [`${P} plugin list --format=json ${FIELDS_FAST} ${SAFE}`]: { stdout: plugins },
      [`${P} theme list --format=json ${FIELDS_FAST} ${SAFE}`]: { stdout: themes },
      [`${P} maintenance-mode is-active ${SAFE}`]: { exitCode: 1 },
    });
    const result = (await handleJob(
      {
        type: "site.inventory",
        target: { ...target, hostKey: `SHA256:${"B".repeat(43)}` },
        checkUpdates: false,
      },
      { vault: vaultWith(), ssh: connector },
    )) as { warnings: string[]; plugins: { name: string }[] };
    expect(result).toMatchObject({
      hostKeyMismatch: false,
      wpVersion: "7.1.4",
      phpVersion: "8.3.36",
      wpCliVersion: "2.12.0",
      maintenance: false,
      safeMode: false,
    });
    expect(result.plugins.map((p) => p.name)).toEqual(["akismet", "hello", "object-cache.php"]);
    expect(result.warnings).toContain(
      "Update availability was not checked (use Check for updates).",
    );
    expect(result.warnings).toContain("Skipped entries WP-CLI reported oddly: weird");
    expect(result).toMatchObject({ updatesChecked: false, coreUpdateVersion: null });
    expect(
      exec.mock.calls.some(([argv]) => (argv as string[]).join(" ").includes("check-update")),
    ).toBe(false);
    const listCalls = exec.mock.calls.map(([argv]) => (argv as string[]).join(" "));
    expect(
      listCalls.some(
        (c) => c.includes("plugin list") && c.includes(SAFE) && !c.includes("update_version"),
      ),
    ).toBe(true);
    expect(listCalls.some((c) => c.includes("plugin list") && c.includes("update_version"))).toBe(
      false,
    );
    for (const [argv] of exec.mock.calls) expect(argv[0]).toBe("wp");
  });

  it("checkUpdates loads plugins and records available updates", async () => {
    const { connector, exec } = fakeSsh({
      ...OK_OUTPUTS,
      [`${P} plugin list --format=json ${FIELDS}`]: { stdout: plugins },
      [`${P} theme list --format=json ${FIELDS}`]: { stdout: themes },
      [`${P} maintenance-mode is-active ${SAFE}`]: { exitCode: 1 },
      // PHP notice noise around the JSON, several offers: the newest wins (A135).
      [`${P} core check-update --format=json --fields=version,update_type ${SAFE}`]: {
        stdout: `Notice: something\n${JSON.stringify([
          { version: "7.2.1", update_type: "major" },
          { version: "7.1.10", update_type: "minor" },
          { version: "latest; id", update_type: "major" },
        ])}`,
      },
    });
    const result = (await handleJob(
      { type: "site.inventory", target, checkUpdates: true },
      { vault: vaultWith(), ssh: connector },
    )) as {
      updatesChecked: boolean;
      coreUpdateVersion: string | null;
      safeMode: boolean;
      plugins: { name: string; updateVersion: string | null }[];
      themes: { name: string; updateVersion: string | null }[];
    };
    expect(result.safeMode).toBe(false);
    expect(result.updatesChecked).toBe(true);
    expect(result.coreUpdateVersion).toBe("7.2.1");
    expect(result.plugins.find((p) => p.name === "akismet")?.updateVersion).toBe("5.4");
    expect(result.themes.find((t) => t.name === "parent")?.updateVersion).toBe("newer version");
    const listCalls = exec.mock.calls.map(([argv]) => (argv as string[]).join(" "));
    expect(
      listCalls.some(
        (c) => c.includes("plugin list") && c.includes("update_version") && !c.includes(SAFE),
      ),
    ).toBe(true);
  });

  it("falls back to skipping plugins and themes when a plugin crashes WP-CLI", async () => {
    const { connector } = fakeSsh({
      ...OK_OUTPUTS,
      [`${P} plugin list --format=json ${FIELDS}`]: {
        exitCode: 255,
        stderr: `PHP Fatal error: Uncaught Error in broken.php ${KEY}`,
      },
      [`${P} plugin list --format=json ${FIELDS} ${SAFE}`]: { stdout: plugins },
      [`${P} theme list --format=json ${FIELDS} ${SAFE}`]: { stdout: themes },
      [`${P} maintenance-mode is-active ${SAFE}`]: { exitCode: 0 },
    });
    const result = (await handleJob(
      { type: "site.inventory", target, checkUpdates: true },
      { vault: vaultWith(), ssh: connector },
    )) as { safeMode: boolean; maintenance: boolean; warnings: string[] };
    expect(result.safeMode).toBe(true);
    expect(result.maintenance).toBe(true);
    expect(result.warnings[0]).toContain("PHP Fatal error");
    expect(JSON.stringify(result)).not.toContain("secretmaterial");
  });

  it("fails with a redacted reason when WordPress can't be read", async () => {
    const { connector } = fakeSsh({
      ...OK_OUTPUTS,
      [`${P} core version`]: {
        exitCode: 1,
        stderr: `Error: This does not seem to be a WordPress installation. ${KEY}`,
      },
    });
    const error = await handleJob(
      { type: "site.inventory", target },
      { vault: vaultWith(), ssh: connector },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("WordPress not found at /var/www/html");
    expect((error as Error).message).not.toContain("secretmaterial");
  });

  it("caps what it returns and ignores malformed lists", async () => {
    const many = JSON.stringify(
      Array.from({ length: 1200 }, (_, i) => ({
        name: `p${i}`,
        status: "inactive",
        title: "x".repeat(400),
      })),
    );
    const { connector } = fakeSsh({
      ...OK_OUTPUTS,
      [`${P} plugin list --format=json ${FIELDS_FAST} ${SAFE}`]: { stdout: many },
      [`${P} theme list --format=json ${FIELDS_FAST} ${SAFE}`]: { stdout: "not json" },
      [`${P} maintenance-mode is-active ${SAFE}`]: { exitCode: 1 },
    });
    const result = (await handleJob(
      { type: "site.inventory", target, checkUpdates: false },
      { vault: vaultWith(), ssh: connector },
    )) as { plugins: { title: string }[]; themes: unknown[]; warnings: string[] };
    expect(result.plugins).toHaveLength(1000);
    expect(result.plugins[0]?.title).toHaveLength(300);
    expect(result.themes).toEqual([]);
    expect(result.warnings.some((w) => /^Themes could not be listed/.test(w))).toBe(true);
  });
});
