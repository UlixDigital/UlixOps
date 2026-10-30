// Runner job handlers. Every job is validated again here: the API is not trusted.
import {
  Command,
  type CredentialInfo,
  type ExecResult,
  type HealthJobResult,
  type PluginDeployResult,
  type RemoteCommandResult,
  RunnerJob,
  type SiteInventoryResult,
  type SiteTestResult,
  type SnapshotJobResult,
  type SshTarget,
  toArgv,
} from "@ulixops/shared";
// Default import: Node ESM can't see `utils` as a named export of the CommonJS ssh2 package.
import ssh2 from "ssh2";
import { z } from "zod";
import { runHealthCheck } from "./health";
import { readInventory } from "./inventory";
import { clearMaintenanceFile, maintenanceFilePresent } from "./maintenance";
import { deployPlugin } from "./plugin-deploy";
import type { PluginStoreReader } from "./plugin-store";
import { redact } from "./redact";
import type { SnapshotStore } from "./snapshot-store";
import { captureSnapshot, restoreSnapshot } from "./snapshots";
import { HostKeyMismatchError, type SshConnector, type SshSession } from "./ssh";
import { type Vault, VaultError } from "./vault";

export interface RunnerDeps {
  vault: Vault;
  ssh: SshConnector;
  now?: () => number;
  /** Required for site.snapshot / site.snapshot.restore (Build Order step 8). */
  snapshots?: { store: SnapshotStore; encryptionKey: string };
  /** Required for site.plugin.deploy (Build Order step 10). */
  plugins?: PluginStoreReader;
}

const CliInfo = z.object({ wp_cli_version: z.string(), php_version: z.string() });

export async function handleJob(data: unknown, deps: RunnerDeps): Promise<unknown> {
  const job = RunnerJob.parse(data);
  switch (job.type) {
    case "credentials.list":
      return { credentials: await deps.vault.list() } satisfies { credentials: CredentialInfo[] };
    case "credentials.create":
      return createCredential(job.name, deps);
    case "site.test":
      return testSite(job.target, deps, job.wpPathCandidates);
    case "site.inventory":
      return inventory(job.target, deps, job.checkUpdates);
    case "remote.command":
      return runCommand(job.target, job.command, deps);
    case "site.snapshot":
      return runSnapshot("capture", job, deps);
    case "site.snapshot.restore":
      return runSnapshot("restore", job, deps);
    case "site.health":
      return health(job, deps);
    case "site.plugin.deploy":
      return pluginDeploy(job, deps);
  }
}

async function pluginDeploy(
  job: {
    target: SshTarget;
    plugin: string;
    storageKey: string;
    sha256: string;
  },
  deps: RunnerDeps,
): Promise<PluginDeployResult> {
  if (!deps.plugins) throw new Error("Plugin store is not configured on the runner");
  const zipBytes = await deps.plugins.readVersion(job.storageKey, job.sha256);
  return unlessHostKeyChanged(() =>
    withSession(job.target, deps, async (session) =>
      deployPlugin(session, job.target, { plugin: job.plugin, zipBytes }, deps.now ?? Date.now),
    ),
  );
}

async function health(
  job: {
    target: SshTarget;
    urls: string[];
    origin: string;
    thresholdMs: number;
    checkErrorLog: boolean;
  },
  deps: RunnerDeps,
): Promise<HealthJobResult> {
  return unlessHostKeyChanged(() =>
    withSession(job.target, deps, async (session) =>
      runHealthCheck(
        session,
        job.target,
        {
          urls: job.urls,
          origin: job.origin,
          thresholdMs: job.thresholdMs,
          checkErrorLog: job.checkErrorLog,
        },
        deps.now ?? Date.now,
      ),
    ),
  );
}

async function runSnapshot(
  mode: "capture" | "restore",
  job:
    | {
        type: "site.snapshot";
        target: SshTarget;
        backupId: string;
        plugin: string;
        includeDb: boolean;
        asset?: "plugin" | "theme";
      }
    | {
        type: "site.snapshot.restore";
        target: SshTarget;
        backupId: string;
        plugin: string;
        includesDb: boolean;
        asset?: "plugin" | "theme";
        location?: string;
      },
  deps: RunnerDeps,
): Promise<SnapshotJobResult> {
  if (!deps.snapshots) throw new Error("Snapshot store is not configured on the runner");
  const snap = deps.snapshots;
  return unlessHostKeyChanged(() =>
    withSession(job.target, deps, async (session, secret) => {
      if (mode === "capture" && job.type === "site.snapshot") {
        return captureSnapshot(
          session,
          job.target,
          {
            backupId: job.backupId,
            plugin: job.plugin,
            includeDb: job.includeDb,
            asset: job.asset ?? "plugin",
          },
          secret,
          { store: snap.store, encryptionKey: snap.encryptionKey, now: deps.now },
        );
      }
      if (mode === "restore" && job.type === "site.snapshot.restore") {
        return restoreSnapshot(
          session,
          job.target,
          {
            backupId: job.backupId,
            plugin: job.plugin,
            includesDb: job.includesDb,
            asset: job.asset ?? "plugin",
            location: job.location,
          },
          secret,
          { store: snap.store, encryptionKey: snap.encryptionKey, now: deps.now },
        );
      }
      throw new Error("unreachable");
    }),
  );
}

/** A new Ed25519 key: the private half goes straight into the vault, the public half is returned. */
async function createCredential(name: string, deps: RunnerDeps) {
  const keys = ssh2.utils.generateKeyPairSync("ed25519", { comment: `ulixops:${name}` });
  await deps.vault.create(name, keys.private, "SSH key created by UlixOps");
  return { name, publicKey: keys.public.trim() };
}

async function withSession<T>(
  target: SshTarget,
  deps: RunnerDeps,
  use: (session: SshSession, secret: string) => Promise<T>,
): Promise<T> {
  const privateKey = await deps.vault.read(target.credentialRef);
  const session = await deps.ssh.connect(target, privateKey);
  try {
    return await use(session, privateKey);
  } finally {
    session.close();
  }
}

/** A changed host key is an answer (the API alerts on it), not a crash: nothing ran. */
async function unlessHostKeyChanged<T>(
  run: () => Promise<T>,
): Promise<T | { hostKeyMismatch: true; expected: string; presented: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HostKeyMismatchError)
      return { hostKeyMismatch: true, expected: error.expected, presented: error.presented };
    throw error;
  }
}

async function runCommand(
  target: SshTarget,
  command: unknown,
  deps: RunnerDeps,
): Promise<RemoteCommandResult> {
  const now = deps.now ?? Date.now;
  const parsed = Command.parse(command);
  return unlessHostKeyChanged(() =>
    withSession(target, deps, async (session, secret) => {
      const started = now();
      let result: ExecResult = await session.exec(toArgv(parsed, { wpPath: target.wpPath }));

      // Stuck plugin/theme updates leave `.maintenance` even when WP-CLI says "off" (A111).
      if (parsed.op === "maintenance.status" && result.exitCode !== 0) {
        const sftp = await session.sftp();
        try {
          if (await maintenanceFilePresent(sftp, target.wpPath)) {
            result = {
              ...result,
              exitCode: 0,
              stdout: [result.stdout.trim(), ".maintenance file present"]
                .filter(Boolean)
                .join("\n"),
            };
          }
        } finally {
          sftp.close();
        }
      }

      if (parsed.op === "maintenance" && parsed.on === false) {
        const sftp = await session.sftp();
        try {
          const cleared = await clearMaintenanceFile(sftp, target.wpPath);
          if (cleared) {
            result = {
              ...result,
              // Clearing the lock file is enough to bring visitors back even if WP-CLI failed.
              exitCode: 0,
              stdout: [result.stdout.trim(), "Removed leftover .maintenance file"]
                .filter(Boolean)
                .join("\n"),
            };
          }
        } finally {
          sftp.close();
        }
      }

      return {
        hostKeyMismatch: false as const,
        exitCode: result.exitCode,
        stdout: redact(result.stdout, [secret], 200_000),
        stderr: redact(result.stderr, [secret], 20_000),
        hostKey: session.hostKey,
        durationMs: now() - started,
      };
    }),
  );
}

async function inventory(
  target: SshTarget,
  deps: RunnerDeps,
  checkUpdates?: boolean,
): Promise<SiteInventoryResult> {
  return unlessHostKeyChanged(() =>
    withSession(target, deps, (session, secret) =>
      readInventory(session, target, secret, deps.now ?? Date.now, { checkUpdates }),
    ),
  );
}

/** "Test connection" (spec 6.1): SSH, WP-CLI available, WordPress and PHP versions. */
async function testSite(
  target: SshTarget,
  deps: RunnerDeps,
  extraPaths?: string[],
): Promise<SiteTestResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const result: SiteTestResult = {
    ok: false,
    steps: [],
    hostKey: null,
    hostKeyMismatch: false,
    wpVersion: null,
    phpVersion: null,
    wpCliVersion: null,
    wpPath: null,
    durationMs: 0,
  };
  const finish = () => ({ ...result, durationMs: now() - started });
  const paths = [
    ...new Set([target.wpPath, ...(extraPaths ?? [])].filter((p): p is string => Boolean(p))),
  ].slice(0, 4);

  let privateKey: string;
  try {
    privateKey = await deps.vault.read(target.credentialRef);
    result.steps.push({
      name: "vault",
      ok: true,
      detail: `SSH key "${target.credentialRef}" found`,
    });
  } catch (error) {
    const detail = error instanceof VaultError ? error.message : "The vault could not be reached";
    result.steps.push({ name: "vault", ok: false, detail });
    return finish();
  }

  let session: SshSession;
  try {
    session = await deps.ssh.connect(target, privateKey);
  } catch (error) {
    if (error instanceof HostKeyMismatchError) {
      result.hostKey = error.presented;
      result.hostKeyMismatch = true;
      result.steps.push({
        name: "ssh",
        ok: false,
        detail: `The server's host key changed (expected ${error.expected}, got ${error.presented}). If the server was rebuilt, an Admin can reset the pinned key; otherwise, investigate before trusting it.`,
      });
    } else {
      const message = error instanceof Error ? error.message : "unknown error";
      result.steps.push({
        name: "ssh",
        ok: false,
        detail: redact(`SSH failed: ${message}`, [privateKey]),
      });
    }
    return finish();
  }

  try {
    result.hostKey = session.hostKey;
    result.steps.push({
      name: "ssh",
      ok: true,
      detail: `Connected as ${target.user}@${target.host}:${target.port}`,
    });

    let lastWpCliDetail = "";
    let lastWpDetail = "";
    for (const wpPath of paths) {
      const info = await session.exec(toArgv({ op: "cli.info" }, { wpPath }), 30_000);
      const parsed = info.exitCode === 0 ? CliInfo.safeParse(safeJson(info.stdout)) : null;
      if (!parsed?.success) {
        lastWpCliDetail = redact(
          `WP-CLI not available at ${wpPath} (exit ${info.exitCode}): ${info.stderr || info.stdout}`,
          [privateKey],
          500,
        );
        continue;
      }
      const core = await session.exec(toArgv({ op: "core.version" }, { wpPath }), 30_000);
      const version = core.stdout.trim();
      if (core.exitCode !== 0 || !/^\d+\.\d+(\.\d+)?/.test(version)) {
        lastWpDetail = redact(
          `WordPress not found at ${wpPath}: ${core.stderr || core.stdout}`,
          [privateKey],
          500,
        );
        continue;
      }
      result.wpCliVersion = parsed.data.wp_cli_version;
      result.phpVersion = parsed.data.php_version;
      result.wpVersion = version;
      result.wpPath = wpPath;
      result.steps.push({
        name: "wp-cli",
        ok: true,
        detail: `WP-CLI ${result.wpCliVersion}, PHP ${result.phpVersion}`,
      });
      result.steps.push({
        name: "wordpress",
        ok: true,
        detail: `WordPress ${version} at ${wpPath}`,
      });
      result.ok = true;
      return finish();
    }

    result.steps.push({
      name: "wp-cli",
      ok: false,
      detail: lastWpCliDetail || lastWpDetail || "WP-CLI not available at any candidate path",
    });
    if (lastWpDetail && !lastWpCliDetail.includes("WP-CLI not available")) {
      result.steps.push({ name: "wordpress", ok: false, detail: lastWpDetail });
    }
    return finish();
  } finally {
    session.close();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
