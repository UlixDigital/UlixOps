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
import { readVulnFeed } from "./vuln-feed";
import { setApiKey, setFilesSftpPassword } from "./api-keys";
import { driveAuthFinish, driveAuthStart, driveDelete, driveStatus } from "./drive-jobs";
import { requestBackupCancel, runFullBackup } from "./full-backup";
import { runFullRestore } from "./full-restore";
import { readErrorLog } from "./errorlog";
import { switchDebugLog } from "./debuglog";
import { runSiteFiles } from "./files";
import type { FilesSessionPool } from "./files-pool";
import { applyChanges, listRecords, listZones, purgeCache } from "./cloudflare";
import { type ExpiryDeps, runExpiryChecks } from "./expiry";
import { runUptimeProbes, type UptimeDeps } from "./uptime";
import { runIntegrityCheck } from "./integrity";
import { requestCancel, runMalwareScan } from "./malware-scan";
import type { SealKeys } from "./sealed";
import { runVisualCapture } from "./visual";

export interface RunnerDeps {
  vault: Vault;
  ssh: SshConnector;
  /** Reuses SSH sockets for site.files so folder clicks are not a full reconnect (A183). */
  filesPool?: FilesSessionPool;
  now?: () => number;
  /** Required for site.snapshot / site.snapshot.restore (Build Order step 8). */
  snapshots?: { store: SnapshotStore; encryptionKey: string };
  /** Required for site.plugin.deploy (Build Order step 10). */
  plugins?: PluginStoreReader;
  /** In-memory key pair for secrets.publicKey / secrets.set (A133). */
  seal?: SealKeys;
  /** Shared scan-work folder for the scanner sidecar (A138, A140). */
  scanWorkDir?: string;
  /** Shared visual-work + visual-store for the Playwright sidecar (A163). */
  visualWorkDir?: string;
  visualStoreDir?: string;
  /** Reports job progress to the API (BullMQ updateProgress), A143. */
  progress?: (data: unknown) => Promise<void>;
  /** TLS probe / fetch overrides for monitor.expiry (tests), A148. */
  expiry?: ExpiryDeps;
  /** fetch override for monitor.uptime (tests), A149. */
  uptime?: UptimeDeps;
  /** fetch override for the debug.log exposure probe (tests), A160. */
  webFetch?: typeof fetch;
  /** fetch override for the Cloudflare API (tests), A156. */
  cloudflareFetch?: typeof fetch;
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
    case "vuln.feed":
      return readVulnFeed(job.wanted, { vault: deps.vault, now: deps.now });
    case "site.malware.scan": {
      const workDir = deps.scanWorkDir;
      if (!workDir) throw new Error("Malware scanning is not configured on the runner");
      return unlessHostKeyChanged(() =>
        withSession(job.target, deps, (session, secret) =>
          runMalwareScan(session, job.target, job.scanId, secret, {
            workDir,
            now: deps.now,
            expectedFiles: job.expectedFiles,
            progress: deps.progress,
          }),
        ),
      );
    }
    case "site.backup":
      return unlessHostKeyChanged(() =>
        withSession(job.target, deps, (session, secret) =>
          runFullBackup(session, job.target, job, secret, {
            vault: deps.vault,
            now: deps.now,
            progress: deps.progress,
          }),
        ),
      );
    case "site.backup.cancel":
      return { running: requestBackupCancel(job.backupId) };
    case "site.backup.restore":
      return unlessHostKeyChanged(() =>
        withSession(job.target, deps, (session, secret) =>
          runFullRestore(session, job.target, job, secret, {
            vault: deps.vault,
            now: deps.now,
            progress: deps.progress,
          }),
        ),
      );
    case "site.errorlog":
      return unlessHostKeyChanged(() =>
        withSession(job.target, deps, async (session, secret) => ({
          hostKeyMismatch: false as const,
          hostKey: session.hostKey,
          ...(await readErrorLog(session, job.target, secret, deps.now, { trim: job.trim })),
        })),
      );
    case "site.debuglog":
      return unlessHostKeyChanged(() =>
        withSession(job.target, deps, (session, secret) =>
          switchDebugLog(session, job.target, job, secret, {
            fetchImpl: deps.webFetch,
            now: deps.now,
          }),
        ),
      );
    case "drive.delete":
      return driveDelete(job.fileIds, { vault: deps.vault, now: deps.now });
    case "drive.status":
      return driveStatus({ vault: deps.vault, now: deps.now });
    case "drive.auth.start":
      return driveAuthStart(job.redirectUri, { vault: deps.vault, now: deps.now });
    case "drive.auth.finish":
      return driveAuthFinish(job, { vault: deps.vault, seal: deps.seal, now: deps.now });
    case "site.integrity":
      return unlessHostKeyChanged(() =>
        withSession(job.target, deps, (session, secret) =>
          runIntegrityCheck(session, job.target, secret, deps.now),
        ),
      );
    case "site.files":
      return unlessHostKeyChanged(async () => {
        const runOnce = () =>
          deps.filesPool
            ? deps.filesPool.withSession(job.target, (session) =>
                runSiteFiles(session, job.target, job.op, deps.now),
              )
            : withSession(job.target, deps, (session) =>
                runSiteFiles(session, job.target, job.op, deps.now),
              );
        try {
          return await runOnce();
        } catch {
          // Pooled socket may have gone stale; one reconnect, then soft-fail (A181/A183).
          try {
            return await runOnce();
          } catch (error) {
            return {
              hostKeyMismatch: false as const,
              hostKey: job.target.hostKey ?? "",
              kind: "mutate" as const,
              ok: false as const,
              detail: cleanFilesConnectError(error, job.target),
              durationMs: 0,
            };
          }
        }
      });
    case "site.malware.cancel":
      return { running: requestCancel(job.scanId) };
    case "monitor.expiry":
      return runExpiryChecks(job.checks, { now: deps.now, ...deps.expiry });
    case "monitor.uptime":
      return runUptimeProbes(job.probes, { now: deps.now, ...deps.uptime });
    case "site.visual.capture": {
      if (!deps.visualWorkDir || !deps.visualStoreDir)
        throw new Error("Visual checks are not configured on the runner");
      return runVisualCapture(
        {
          checkId: job.checkId,
          mode: job.mode,
          pages: job.pages,
          sshHost: job.sshHost,
          viewportWidth: job.viewportWidth,
          viewportHeight: job.viewportHeight,
          maxDiffPercent: job.maxDiffPercent,
          pixelThreshold: job.pixelThreshold,
        },
        { workDir: deps.visualWorkDir, storeDir: deps.visualStoreDir, now: deps.now },
      );
    }
    case "dns.zones":
      return listZones({ vault: deps.vault, fetchImpl: deps.cloudflareFetch });
    case "dns.records":
      return listRecords(job.zoneId, { vault: deps.vault, fetchImpl: deps.cloudflareFetch });
    case "dns.apply":
      return applyChanges(job.zoneId, job.changes, {
        vault: deps.vault,
        fetchImpl: deps.cloudflareFetch,
      });
    case "dns.purge":
      return purgeCache(job.zoneId, job.everything, job.urls, {
        vault: deps.vault,
        fetchImpl: deps.cloudflareFetch,
      });
    case "secrets.publicKey":
      if (!deps.seal) throw new Error("Secret sealing is not configured on the runner");
      return deps.seal.publicKey();
    case "secrets.set":
      if (!deps.seal) throw new Error("Secret sealing is not configured on the runner");
      return setApiKey(job, { vault: deps.vault, seal: deps.seal, now: deps.now });
    case "secrets.setFilesSftpPassword":
      if (!deps.seal) throw new Error("Secret sealing is not configured on the runner");
      return setFilesSftpPassword(job, { vault: deps.vault, seal: deps.seal, now: deps.now });
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

/** Redacted connect/auth errors for the Files tab (never leak key material). */
function cleanFilesConnectError(error: unknown, target: SshTarget): string {
  if (error instanceof VaultError)
    return redact(`SSH key "${target.credentialRef}" is missing from the vault.`).slice(0, 500);
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (lower.includes("authentication") || lower.includes("all configured authentication")) {
    if (target.authMode === "password") {
      return redact(
        `Authentication failed for ${target.user}@${target.host}:${target.port} with the saved SFTP password. Check user and password (same as FileZilla), then re-save under Faster SFTP connection.`,
      ).slice(0, 500);
    }
    return redact(
      `Authentication failed for ${target.user}@${target.host}:${target.port} with vault key "${target.credentialRef}". For WP Engine FileZilla users, switch Faster SFTP to Password auth and enter that password.`,
    ).slice(0, 500);
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return redact(
      `Timed out connecting to ${target.host}:${target.port}. Check host and port (FileZilla SFTP is often *.sftp.wpengine.com:2222).`,
    ).slice(0, 500);
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo") || lower.includes("dns")) {
    return redact(`Could not resolve host ${target.host}.`).slice(0, 500);
  }
  return redact(raw).slice(0, 500);
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

/** Large WP-CLI ops (Elementor etc.) routinely exceed the default 60 s SSH exec cap (A131). */
const SLOW_COMMAND_TIMEOUT_MS = 300_000;

function commandTimeoutMs(op: Command["op"]): number {
  switch (op) {
    case "plugin.update":
    case "theme.update":
    case "db.export":
    case "db.import":
    case "db.reset":
    case "core.update":
    case "core.update-db":
      return SLOW_COMMAND_TIMEOUT_MS;
    default:
      return 60_000;
  }
}

const STREAM_OPS: ReadonlySet<Command["op"]> = new Set([
  "backup.archive",
  "restore.database",
  "restore.files",
  // Only ever part of a restore (A157): never run on their own.
  "restore.dump-prefix",
  "restore.clear-content",
  "db.search-replace",
  "db.reset",
  // wp-config.php debug constants: only through the error-logging switch (A160).
  "config.get",
  "config.set",
  "config.delete",
]);

async function runCommand(
  target: SshTarget,
  command: unknown,
  deps: RunnerDeps,
): Promise<RemoteCommandResult> {
  const now = deps.now ?? Date.now;
  const parsed = Command.parse(command);
  // Streaming ops run only inside their own jobs (site.backup, site.backup.restore), A152.
  if (STREAM_OPS.has(parsed.op)) throw new Error(`${parsed.op} can't run as a plain command`);
  return unlessHostKeyChanged(() =>
    withSession(target, deps, async (session, secret) => {
      const started = now();
      let result: ExecResult = await session.exec(
        toArgv(parsed, { wpPath: target.wpPath }),
        commandTimeoutMs(parsed.op),
      );

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
