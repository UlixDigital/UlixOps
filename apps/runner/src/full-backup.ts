// `site.backup` (Phase 2 step 5, A145): one full backup of an environment to Google Drive.
// Database dump on the site (/tmp) → `tar -cz` of the WordPress folder plus the dump, streamed
// over SSH → encrypted (ULXB) → resumable upload → size and MD5 checked against Drive → only then
// the older copies are deleted from Drive (permanently, not to Trash). Nothing on the site
// changes except the temporary dump, which is removed at the end.
import {
  BACKUP_KEY_REF,
  DRIVE_CLIENT_ID_REF,
  DRIVE_CLIENT_SECRET_REF,
  DRIVE_REFRESH_TOKEN_REF,
  type FullBackupJobResult,
  type FullBackupProgress,
  type SshTarget,
  toArgv,
} from "@ulixops/shared";
import { BackupEncryptor } from "./backup-crypto";
import { DriveAuthError, DriveError, GoogleDrive } from "./drive";
import { redact } from "./redact";
import type { SshSession } from "./ssh";
import { type Vault, VaultError } from "./vault";

const DUMP_TIMEOUT_MS = 30 * 60_000;
const ARCHIVE_TIMEOUT_MS = 5 * 60 * 60_000;
const DEFAULT_EXPECTED = 500_000_000;

export interface FullBackupJob {
  backupId: string;
  folderKey: string;
  folderName: string;
  fileStem: string;
  expectedBytes?: number;
  oldFileIds: string[];
}

export interface FullBackupDeps {
  vault: Vault;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  progress?: (p: FullBackupProgress) => Promise<void>;
}

// ---- Stop (A145, like A143) ------------------------------------------------------------------
const active = new Set<string>();
const cancelRequests = new Map<string, number>();

export function requestBackupCancel(backupId: string, at = Date.now()): boolean {
  for (const [id, when] of cancelRequests) if (at - when > 6 * 3_600_000) cancelRequests.delete(id);
  cancelRequests.set(backupId, at);
  return active.has(backupId);
}

/** Reads a vault secret, or null when it isn't there. */
export async function secretOrNull(vault: Vault, name: string): Promise<string | null> {
  try {
    return (await vault.read(name)).trim();
  } catch (error) {
    if (error instanceof VaultError && error.kind === "not_found") return null;
    throw error;
  }
}

const stamp = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

export async function runFullBackup(
  session: SshSession,
  target: SshTarget,
  job: FullBackupJob,
  secret: string,
  deps: FullBackupDeps,
): Promise<FullBackupJobResult & { hostKeyMismatch: false }> {
  const now = deps.now ?? Date.now;
  const started = now();
  const secrets = [secret];
  const clean = (text: string) => redact(text.trim(), secrets, 1500);
  const result = (
    over: Partial<FullBackupJobResult & { hostKeyMismatch: false }>,
  ): FullBackupJobResult & { hostKeyMismatch: false } => ({
    hostKeyMismatch: false,
    hostKey: session.hostKey,
    ok: false,
    driveFileId: null,
    fileName: null,
    sizeBytes: 0,
    md5: null,
    webViewLink: null,
    removed: [],
    removeFailed: [],
    detail: "",
    durationMs: now() - started,
    ...over,
  });
  const cancelled = () => cancelRequests.has(job.backupId);
  const stopped = () => result({ cancelled: true, detail: "Stopped on request." });
  if (!/^[a-z0-9]{1,64}$/.test(job.backupId)) throw new Error("invalid backup id");
  if (cancelled()) return stopped();
  if (!session.execStream) return result({ detail: "This connection can't stream files." });

  let lastReport = 0;
  const report = async (p: FullBackupProgress, force = false) => {
    if (!deps.progress || (!force && now() - lastReport < 2_000)) return;
    lastReport = now();
    await deps.progress(p).catch(() => undefined);
  };

  const [clientId, clientSecret, refreshToken, key] = await Promise.all([
    secretOrNull(deps.vault, DRIVE_CLIENT_ID_REF),
    secretOrNull(deps.vault, DRIVE_CLIENT_SECRET_REF),
    secretOrNull(deps.vault, DRIVE_REFRESH_TOKEN_REF),
    secretOrNull(deps.vault, BACKUP_KEY_REF),
  ]);
  for (const s of [clientSecret, refreshToken, key]) if (s) secrets.push(s);
  if (!clientId || !clientSecret || !refreshToken)
    return result({ detail: "Google Drive isn't connected. Connect it on the Backups page." });
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key))
    return result({
      detail: "No backup encryption key. Add it in Settings → Credentials before backing up.",
    });

  const dbFile = `/tmp/ulixops-${job.backupId}.sql`;
  active.add(job.backupId);
  try {
    const drive = new GoogleDrive(
      { clientId, clientSecret, refreshToken },
      deps.fetchImpl,
      deps.sleep,
    );
    const root = await drive.ensureFolder("UlixOps Backups", null, "root");
    const folder = await drive.ensureFolder(job.folderName, root, job.folderKey);

    // 1. Database dump on the site.
    await report({ phase: "database", percent: 2, bytes: 0 }, true);
    const dump = await session.exec(
      toArgv({ op: "db.export", file: dbFile }, { wpPath: target.wpPath }),
      DUMP_TIMEOUT_MS,
    );
    if (dump.exitCode !== 0)
      return result({ detail: clean(`The database export failed: ${dump.stderr || dump.stdout}`) });
    if (cancelled()) return stopped();

    // 2. Stream site + dump, encrypted, to Drive.
    const fileName = `${job.fileStem}-${stamp(started)}.tar.gz.ulxb`;
    const upload = await drive.startUpload(fileName, folder);
    const enc = new BackupEncryptor(key);
    const expected = job.expectedBytes ?? DEFAULT_EXPECTED;
    await report({ phase: "uploading", percent: 5, bytes: 0 }, true);
    const archived = await session.execStream(
      toArgv({ op: "backup.archive", wpPath: target.wpPath, dbFile }),
      async (chunk) => {
        if (cancelled()) return "stop";
        await upload.write(enc.push(chunk));
        await report({
          phase: "uploading",
          percent: Math.min(95, 5 + Math.floor((90 * upload.total) / expected)),
          bytes: upload.total,
        });
        return "more";
      },
      ARCHIVE_TIMEOUT_MS,
    );
    if (cancelled()) return stopped();
    // GNU tar exits 1 when a file changed while it was read: the archive is still complete.
    if (archived.stopped || (archived.exitCode !== 0 && archived.exitCode !== 1))
      return result({
        detail: clean(
          `Archiving the site failed (tar exit ${archived.exitCode}): ${archived.stderr}`,
        ),
      });
    await upload.write(enc.finish());
    const fileId = await upload.finish();
    const md5 = upload.md5.digest("hex");

    // 3. Verify what Drive stored before trusting it (and before deleting anything).
    await report({ phase: "verifying", percent: 97, bytes: upload.total }, true);
    const stored = await drive.getFile(fileId);
    if (
      !stored ||
      stored.size !== upload.total ||
      (stored.md5Checksum && stored.md5Checksum !== md5)
    ) {
      await drive.deleteFile(fileId).catch(() => false);
      return result({
        detail: `Drive's copy didn't match what was sent (size ${stored?.size ?? "?"} of ${upload.total}); it was deleted and older backups were kept.`,
      });
    }

    // 4. Only now remove the older copies (permanently).
    await report({ phase: "cleanup", percent: 99, bytes: upload.total }, true);
    const removed: string[] = [];
    const removeFailed: string[] = [];
    for (const old of job.oldFileIds) {
      if (old === fileId) continue;
      const ok = await drive.deleteFile(old).catch(() => false);
      (ok ? removed : removeFailed).push(old);
    }
    const mb = (upload.total / 1_000_000).toFixed(upload.total < 10_000_000 ? 1 : 0);
    return result({
      ok: true,
      driveFileId: fileId,
      fileName,
      sizeBytes: upload.total,
      md5,
      webViewLink: stored.webViewLink,
      removed,
      removeFailed,
      detail: [
        `Backed up the database and all files (${mb} MB encrypted) to Google Drive.`,
        removed.length
          ? `Removed ${removed.length} older backup${removed.length === 1 ? "" : "s"} from Drive.`
          : "",
        removeFailed.length
          ? `${removeFailed.length} older backup${removeFailed.length === 1 ? "" : "s"} couldn't be removed; will retry next time.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  } catch (error) {
    if (error instanceof DriveAuthError || error instanceof DriveError)
      return result({ detail: clean(error.message) });
    throw error;
  } finally {
    active.delete(job.backupId);
    cancelRequests.delete(job.backupId);
    // The dump on the site is temporary: remove it whatever happened.
    try {
      const fs = await session.sftp();
      await fs.unlink(dbFile).catch(() => undefined);
      fs.close();
    } catch {
      // best effort
    }
  }
}
