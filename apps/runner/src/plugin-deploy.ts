// Install a custom plugin ZIP from the hub store onto a site over SFTP (Build Order step 10).
import { type PluginDeployResult, type SshTarget, toArgv } from "@ulixops/shared";
import { pluginRemotePath, pluginsDir } from "./snapshots";
import type { SftpFile, SshSession } from "./ssh";
import { unzipStore } from "./zip";

const NEW_SUFFIX = ".__ulixops_new__";
const OLD_SUFFIX = ".__ulixops_old__";

export async function deployPlugin(
  session: SshSession,
  target: SshTarget,
  opts: { plugin: string; zipBytes: Buffer },
  now: () => number = Date.now,
): Promise<PluginDeployResult & { hostKeyMismatch: false }> {
  const started = now();
  const files = unzipStore(opts.zipBytes);
  const payload = extractPluginFiles(files, opts.plugin);
  if (!payload.ok) {
    return {
      hostKeyMismatch: false,
      ok: false,
      hostKey: session.hostKey,
      detail: payload.detail,
      durationMs: now() - started,
    };
  }

  const sftp = await session.sftp();
  const live = pluginRemotePath(target.wpPath, opts.plugin);
  const liveFile = `${live}.php`;
  const staging = `${live}${NEW_SUFFIX}`;
  const backup = `${live}${OLD_SUFFIX}`;
  try {
    // Clear leftovers from a previous interrupted deploy.
    await rmIfExists(sftp, staging);
    await rmIfExists(sftp, `${staging}.php`);
    await rmIfExists(sftp, backup);
    await rmIfExists(sftp, `${backup}.php`);

    if (payload.kind === "dir") {
      await sftp.writeTree(staging, payload.files);
    } else {
      await sftp.writeFile(`${staging}.php`, payload.data);
    }

    const existingDir = await sftp.stat(live);
    const existingFile = existingDir ? null : await sftp.stat(liveFile);
    if (existingDir?.isDirectory) {
      await sftp.rename(live, backup);
    } else if (existingFile && !existingFile.isDirectory) {
      await sftp.rename(liveFile, `${backup}.php`);
    }

    if (payload.kind === "dir") {
      await sftp.rename(staging, live);
    } else {
      await sftp.rename(`${staging}.php`, liveFile);
    }

    const activated = await session.exec(
      toArgv({ op: "plugin.activate", slug: opts.plugin }, { wpPath: target.wpPath }),
      60_000,
    );
    if (activated.exitCode !== 0) {
      await restoreBackup(sftp, live, liveFile, backup, payload.kind);
      return {
        hostKeyMismatch: false,
        ok: false,
        hostKey: session.hostKey,
        detail: `Plugin activate failed (exit ${activated.exitCode})`,
        durationMs: now() - started,
      };
    }

    await rmIfExists(sftp, backup);
    await rmIfExists(sftp, `${backup}.php`);
    return {
      hostKeyMismatch: false,
      ok: true,
      hostKey: session.hostKey,
      detail: `Deployed ${opts.plugin}`,
      durationMs: now() - started,
    };
  } catch (error) {
    try {
      await restoreBackup(sftp, live, liveFile, backup, payload.kind);
    } catch {
      /* best-effort */
    }
    return {
      hostKeyMismatch: false,
      ok: false,
      hostKey: session.hostKey,
      detail: error instanceof Error ? error.message.slice(0, 500) : "Deploy failed",
      durationMs: now() - started,
    };
  } finally {
    sftp.close();
  }
}

type Payload =
  | { ok: true; kind: "dir"; files: SftpFile[] }
  | { ok: true; kind: "file"; data: Buffer }
  | { ok: false; detail: string };

/**
 * Registry ZIPs use the WordPress layout: one top-level folder `<slug>/…` (A61).
 * Snapshot store ZIPs use `plugin/<slug>/…`; accept both.
 */
/** Exported for unit tests (ZIP layout acceptance). */
export function extractPluginFiles(files: Map<string, Buffer>, plugin: string): Payload {
  const registryPrefix = `${plugin}/`;
  const snapshotPrefix = `plugin/${plugin}/`;
  const snapshotSingle = `plugin/${plugin}.php`;
  const dirFiles: SftpFile[] = [];
  let singleFile: Buffer | null = null;

  for (const [raw, data] of files) {
    const name = raw.replace(/^\/+/, "");
    if (name === "manifest.json" || name === "database.sql") continue;
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
      return { ok: false, detail: `Unsafe path in ZIP: ${name.slice(0, 80)}` };
    }
    if (name.startsWith(snapshotPrefix)) {
      const rel = name.slice(snapshotPrefix.length);
      if (!rel || rel.includes("..")) {
        return { ok: false, detail: `Unsafe plugin path: ${name.slice(0, 80)}` };
      }
      dirFiles.push({ path: rel, data });
    } else if (name === snapshotSingle) {
      singleFile = data;
    } else if (name.startsWith(registryPrefix)) {
      const rel = name.slice(registryPrefix.length);
      if (!rel || rel.includes("..")) {
        return { ok: false, detail: `Unsafe plugin path: ${name.slice(0, 80)}` };
      }
      dirFiles.push({ path: rel, data });
    } else if (name.includes("/")) {
      // Another top-level folder — refuse.
      return { ok: false, detail: `ZIP contains unexpected path ${name.slice(0, 80)}` };
    }
  }

  if (dirFiles.length > 0 && singleFile) {
    return { ok: false, detail: "ZIP mixes folder and single-file plugin layouts" };
  }
  if (dirFiles.length > 0) return { ok: true, kind: "dir", files: dirFiles };
  if (singleFile) return { ok: true, kind: "file", data: singleFile };
  return {
    ok: false,
    detail: `ZIP has no ${plugin}/ folder (or plugin/${plugin}/ snapshot layout)`,
  };
}

async function rmIfExists(
  sftp: Awaited<ReturnType<SshSession["sftp"]>>,
  remote: string,
): Promise<void> {
  const info = await sftp.stat(remote);
  if (!info) return;
  if (info.isDirectory) await sftp.rmTree(remote);
  else await sftp.unlink(remote);
}

async function restoreBackup(
  sftp: Awaited<ReturnType<SshSession["sftp"]>>,
  live: string,
  liveFile: string,
  backup: string,
  kind: "dir" | "file",
): Promise<void> {
  if (kind === "dir") {
    await rmIfExists(sftp, live);
    await rmIfExists(sftp, `${live}${NEW_SUFFIX}`);
    const bak = await sftp.stat(backup);
    if (bak?.isDirectory) await sftp.rename(backup, live);
  } else {
    await rmIfExists(sftp, liveFile);
    await rmIfExists(sftp, `${live}${NEW_SUFFIX}.php`);
    const bak = await sftp.stat(`${backup}.php`);
    if (bak && !bak.isDirectory) await sftp.rename(`${backup}.php`, liveFile);
  }
}

/** Exported for tests that assert path helpers stay aligned with snapshots. */
export { pluginsDir };
