// Capture and restore quick pre-update snapshots (spec §6.5). SFTP for the plugin/theme folder;
// WP-CLI for optional DB export/import. Encrypted blobs land in SNAPSHOT_STORE_DIR.
import { type SnapshotJobResult, type SshTarget, toArgv } from "@ulixops/shared";
import { z } from "zod";
import { redact } from "./redact";
import type { SnapshotStore } from "./snapshot-store";
import type { SftpFile, SftpSession, SshSession } from "./ssh";
import { unzipStore, zipStore } from "./zip";

const Manifest = z.object({
  version: z.literal(1),
  plugin: z.string().min(1).max(100),
  pluginVersion: z.string().max(50).nullable(),
  includesDb: z.boolean(),
  createdAt: z.string(),
  asset: z.enum(["plugin", "theme"]).default("plugin"),
});

export interface SnapshotDeps {
  store: SnapshotStore;
  encryptionKey: string;
  now?: () => number;
}

export type SnapshotAsset = "plugin" | "theme";

/** Absolute plugins directory under the WordPress install. */
export function pluginsDir(wpPath: string): string {
  return `${wpPath.replace(/\/$/, "")}/wp-content/plugins`;
}

export function themesDir(wpPath: string): string {
  return `${wpPath.replace(/\/$/, "")}/wp-content/themes`;
}

/** Folder form: …/plugins/<name>. Single-file form is …/plugins/<name>.php (resolved at runtime). */
export function pluginRemotePath(wpPath: string, plugin: string): string {
  return `${pluginsDir(wpPath)}/${plugin}`;
}

export function themeRemotePath(wpPath: string, theme: string): string {
  return `${themesDir(wpPath)}/${theme}`;
}

function assetPaths(wpPath: string, name: string, asset: SnapshotAsset) {
  if (asset === "theme") {
    const dirPath = themeRemotePath(wpPath, name);
    return { dirPath, filePath: `${dirPath}.php`, zipPrefix: "theme/" as const };
  }
  const dirPath = pluginRemotePath(wpPath, name);
  return { dirPath, filePath: `${dirPath}.php`, zipPrefix: "plugin/" as const };
}

export async function captureSnapshot(
  session: SshSession,
  target: SshTarget,
  opts: {
    backupId: string;
    plugin: string;
    includeDb: boolean;
    asset?: SnapshotAsset;
  },
  secret: string,
  deps: SnapshotDeps,
): Promise<SnapshotJobResult & { hostKeyMismatch: false }> {
  const asset = opts.asset ?? "plugin";
  const now = deps.now ?? Date.now;
  const started = now();
  const sftp = await session.sftp();
  try {
    const { dirPath, filePath, zipPrefix } = assetPaths(target.wpPath, opts.plugin, asset);
    const dirInfo = await sftp.stat(dirPath);
    const fileInfo = dirInfo ? null : await sftp.stat(filePath);
    const files = new Map<string, Buffer>();
    let pluginVersion: string | null = null;
    // First install: no folder yet → empty snapshot so rollback can remove the new plugin (A90).
    if (!dirInfo && !fileInfo) {
      if (opts.includeDb) {
        return fail(
          session,
          started,
          now,
          `${asset} not found at ${dirPath} or ${filePath}; cannot include DB without a folder`,
          false,
        );
      }
    } else if (dirInfo?.isDirectory) {
      const tree = await sftp.readTree(dirPath);
      for (const file of tree) files.set(`${zipPrefix}${file.path}`, file.data);
      pluginVersion = readPluginVersion(tree);
    } else {
      // Single-file plugin (e.g. hello.php listed by WP-CLI as "hello").
      const remote = dirInfo && !dirInfo.isDirectory ? dirPath : filePath;
      const data = await sftp.readFile(remote);
      files.set(`${zipPrefix}${opts.plugin}.php`, data);
      pluginVersion = readPluginHeaderVersion(data);
    }

    let includesDb = false;
    if (opts.includeDb) {
      const sqlPath = `/tmp/ulixops-${opts.backupId}.sql`;
      const exported = await session.exec(
        toArgv({ op: "db.export", file: sqlPath }, { wpPath: target.wpPath }),
        120_000,
      );
      if (exported.exitCode !== 0) {
        return fail(
          session,
          started,
          now,
          redact(`DB export failed: ${exported.stderr || exported.stdout}`, [secret], 500),
          false,
        );
      }
      try {
        const sql = await sftp.readFile(sqlPath, 100_000_000);
        files.set("database.sql", sql);
        includesDb = true;
      } finally {
        await sftp.unlink(sqlPath).catch(() => undefined);
      }
    }

    files.set(
      "manifest.json",
      Buffer.from(
        JSON.stringify({
          version: 1,
          plugin: opts.plugin,
          pluginVersion,
          includesDb,
          createdAt: new Date(now()).toISOString(),
          asset,
        } satisfies z.infer<typeof Manifest>),
        "utf8",
      ),
    );

    const plain = zipStore(files);
    const saved = await deps.store.writeEncrypted(opts.backupId, plain, deps.encryptionKey, {
      allowReuse: !includesDb,
    });
    const reuseNote = saved.reused ? "; reused existing blob" : "";
    return {
      hostKeyMismatch: false,
      ok: true,
      hostKey: session.hostKey,
      pluginVersion,
      includesDb,
      sha256: saved.sha256,
      sizeBytes: saved.sizeBytes,
      location: saved.location,
      reused: saved.reused,
      detail: `Snapshot of ${asset} ${opts.plugin}${pluginVersion ? ` ${pluginVersion}` : ""}${includesDb ? " + database" : ""} (${saved.sizeBytes} bytes encrypted)${reuseNote}`,
      durationMs: now() - started,
    };
  } finally {
    sftp.close();
  }
}

export async function restoreSnapshot(
  session: SshSession,
  target: SshTarget,
  opts: {
    backupId: string;
    plugin: string;
    includesDb: boolean;
    asset?: SnapshotAsset;
    location?: string;
  },
  secret: string,
  deps: SnapshotDeps,
): Promise<SnapshotJobResult & { hostKeyMismatch: false }> {
  const now = deps.now ?? Date.now;
  const started = now();
  const plain = await deps.store.readDecrypted(opts.backupId, deps.encryptionKey, {
    location: opts.location,
  });
  const files = unzipStore(plain);
  const manifestRaw = files.get("manifest.json");
  if (!manifestRaw) return fail(session, started, now, "Snapshot missing manifest", false);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(manifestRaw.toString("utf8"));
  } catch {
    return fail(session, started, now, "Snapshot manifest invalid", false);
  }
  const manifest = Manifest.safeParse(parsedJson);
  if (!manifest.success) return fail(session, started, now, "Snapshot manifest invalid", false);
  if (manifest.data.plugin !== opts.plugin) {
    return fail(
      session,
      started,
      now,
      `Snapshot is for ${manifest.data.plugin}, not ${opts.plugin}`,
      false,
    );
  }
  const asset = opts.asset ?? manifest.data.asset ?? "plugin";

  const assetFiles: SftpFile[] = [];
  const prefixes = asset === "theme" ? ["theme/", "plugin/"] : ["plugin/", "theme/"];
  for (const [path, data] of files) {
    for (const prefix of prefixes) {
      if (path.startsWith(prefix) && path !== prefix) {
        assetFiles.push({ path: path.slice(prefix.length), data });
        break;
      }
    }
  }
  const sftp = await session.sftp();
  try {
    const { dirPath, filePath } = assetPaths(target.wpPath, opts.plugin, asset);

    // Empty snapshot = asset was not installed before deploy; remove it on rollback (A90).
    if (assetFiles.length === 0) {
      if (asset === "plugin") {
        await session.exec(
          toArgv(
            { op: "plugin.deactivate", slug: opts.plugin, safe: true },
            { wpPath: target.wpPath },
          ),
          60_000,
        );
      }
      await sftp.rmTree(dirPath).catch(() => undefined);
      await sftp.unlink(filePath).catch(() => undefined);
      const flush = await session.exec(
        toArgv({ op: "cache.flush" }, { wpPath: target.wpPath }),
        60_000,
      );
      const flushNote =
        flush.exitCode === 0 ? "cache flushed" : `cache flush exit ${flush.exitCode}`;
      return {
        hostKeyMismatch: false,
        ok: true,
        hostKey: session.hostKey,
        pluginVersion: null,
        includesDb: false,
        sha256: null,
        sizeBytes: null,
        location: null,
        detail: `Removed ${opts.plugin} (empty pre-deploy snapshot); ${flushNote}`,
        durationMs: now() - started,
      };
    }

    const only = assetFiles[0];
    const singleFile =
      assetFiles.length === 1 &&
      only &&
      !only.path.includes("/") &&
      (only.path === opts.plugin || only.path === `${opts.plugin}.php`);
    const remote = singleFile ? filePath : dirPath;
    const bak = `${remote}.__ulixops_old__`;
    await sftp.rmTree(bak).catch(() => undefined);
    const other = singleFile ? dirPath : filePath;
    await sftp.rmTree(other).catch(() => undefined);
    const existing = await sftp.stat(remote);
    if (existing) await sftp.rename(remote, bak);
    try {
      if (singleFile && only) {
        await sftp.writeFile(remote, only.data);
      } else {
        await sftp.writeTree(remote, assetFiles);
      }
    } catch (error) {
      await restoreFromBak(sftp, remote, bak);
      throw error;
    }

    let includesDb = false;
    if (opts.includesDb) {
      const sql = files.get("database.sql");
      if (!sql) {
        await restoreFromBak(sftp, remote, bak);
        return fail(
          session,
          started,
          now,
          "Snapshot is missing database.sql but a database restore was requested",
          false,
        );
      }
      const sqlPath = `/tmp/ulixops-${opts.backupId}.sql`;
      await sftp.writeFile(sqlPath, sql);
      try {
        const imported = await session.exec(
          toArgv({ op: "db.import", file: sqlPath }, { wpPath: target.wpPath }),
          180_000,
        );
        if (imported.exitCode !== 0) {
          await restoreFromBak(sftp, remote, bak);
          return fail(
            session,
            started,
            now,
            redact(`DB import failed: ${imported.stderr || imported.stdout}`, [secret], 500),
            false,
          );
        }
        includesDb = true;
      } finally {
        await sftp.unlink(sqlPath).catch(() => undefined);
      }
    }

    const flush = await session.exec(
      toArgv({ op: "cache.flush" }, { wpPath: target.wpPath }),
      60_000,
    );
    const flushNote = flush.exitCode === 0 ? "cache flushed" : `cache flush exit ${flush.exitCode}`;

    await sftp.rmTree(bak).catch(() => undefined);

    return {
      hostKeyMismatch: false,
      ok: true,
      hostKey: session.hostKey,
      pluginVersion: manifest.data.pluginVersion,
      includesDb,
      sha256: null,
      sizeBytes: null,
      location: null,
      detail: `Restored ${opts.plugin}${includesDb ? " + database" : ""}; ${flushNote}`,
      durationMs: now() - started,
    };
  } finally {
    sftp.close();
  }
}

/** Best-effort: drop the new plugin path and put the pre-restore copy back. */
async function restoreFromBak(sftp: SftpSession, remote: string, bak: string): Promise<void> {
  await sftp.rmTree(remote).catch(() => undefined);
  const bakExists = await sftp.stat(bak);
  if (bakExists) await sftp.rename(bak, remote).catch(() => undefined);
}

function fail(
  session: SshSession,
  started: number,
  now: () => number,
  detail: string,
  includesDb: boolean,
): SnapshotJobResult & { hostKeyMismatch: false } {
  return {
    hostKeyMismatch: false,
    ok: false,
    hostKey: session.hostKey,
    pluginVersion: null,
    includesDb,
    sha256: null,
    sizeBytes: null,
    location: null,
    detail,
    durationMs: now() - started,
  };
}

function readPluginVersion(tree: SftpFile[]): string | null {
  for (const file of tree) {
    if (!file.path.endsWith(".php") && !file.path.endsWith(".css")) continue;
    if (!file.path.includes("/") || file.path.split("/").length === 2) {
      const version = readPluginHeaderVersion(file.data);
      if (version) return version;
    }
  }
  for (const file of tree) {
    if (file.path.endsWith(".php") || file.path.endsWith(".css")) {
      const version = readPluginHeaderVersion(file.data);
      if (version) return version;
    }
  }
  return null;
}

function readPluginHeaderVersion(data: Buffer): string | null {
  const head = data.subarray(0, Math.min(data.length, 8_192)).toString("utf8");
  const match = /^[ \t/*#@]*Version:\s*(\S+)/im.exec(head);
  return match?.[1]?.slice(0, 50) ?? null;
}
