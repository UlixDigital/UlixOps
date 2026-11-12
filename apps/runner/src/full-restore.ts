// `site.backup.restore` (A152): put a full backup from Google Drive back on the site, after an
// approved request. The backup opens with our key → safety copy of the site as it is now (like
// site.backup, kept separately) → maintenance mode → database: the dump is extracted to /tmp and
// imported (across environments the target database is cleared first) → files: extracted over
// the WordPress folder (never wp-config.php; across environments plugins, themes and uploads
// are removed first) → cache flush,
// maintenance off. The backup streams from Drive through the decryptor straight into tar on the
// site; nothing is stored on the hub.
import {
  BACKUP_KEY_REF,
  DRIVE_CLIENT_ID_REF,
  DRIVE_CLIENT_SECRET_REF,
  DRIVE_REFRESH_TOKEN_REF,
  type RestoreJobResult,
  type RestoreProgress,
  type RestoreScope,
  type SshTarget,
  toArgv,
} from "@ulixops/shared";
import { BackupDecryptError, BackupDecryptor } from "./backup-crypto";
import { DriveAuthError, DriveError, GoogleDrive } from "./drive";
import { runFullBackup, secretOrNull } from "./full-backup";
import { clearMaintenanceFile } from "./maintenance";
import { redact } from "./redact";
import type { SshSession } from "./ssh";
import type { Vault } from "./vault";

const STREAM_TIMEOUT_MS = 5 * 60 * 60_000;
const IMPORT_TIMEOUT_MS = 60 * 60_000;

export interface FullRestoreJob {
  restoreId: string;
  driveFileId: string;
  sourceBackupId: string;
  scope: RestoreScope;
  safetyBackupId: string;
  folderKey: string;
  folderName: string;
  fileStem: string;
  expectedBytes?: number;
  /** Another environment's backup (A157): change the site address after the import. */
  rewrite?: { from: string; to: string };
}

export interface FullRestoreDeps {
  vault: Vault;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  progress?: (p: RestoreProgress) => Promise<void>;
}

type Result = RestoreJobResult & { hostKeyMismatch: false };

/** tar lines that only mean "this one file couldn't be written" (host-managed, read-only). */
const PER_FILE = /^tar: .*: Cannot (open|create|utime|change mode|change ownership|unlink|mkdir)/;
const SUMMARY = /^tar: Exiting with failure status due to previous errors/;

/** The decrypted backup, read from Drive as it is needed; `onBytes` sees encrypted bytes. */
async function* plaintext(
  drive: GoogleDrive,
  fileId: string,
  key: string,
  onBytes: (n: number) => Promise<void>,
): AsyncGenerator<Buffer> {
  const dec = new BackupDecryptor(key);
  for await (const piece of drive.download(fileId)) {
    await onBytes(piece.length);
    const out = dec.push(piece);
    if (out.length) yield out;
  }
  const last = dec.finish();
  if (last.length) yield last;
}

export async function runFullRestore(
  session: SshSession,
  target: SshTarget,
  job: FullRestoreJob,
  secret: string,
  deps: FullRestoreDeps,
): Promise<Result> {
  const now = deps.now ?? Date.now;
  const started = now();
  const secrets = [secret];
  const clean = (text: string) => redact(text.trim(), secrets, 1500);
  const base: Result = {
    hostKeyMismatch: false,
    hostKey: session.hostKey,
    ok: false,
    safety: null,
    changed: false,
    database: false,
    files: false,
    warnings: [],
    detail: "",
    durationMs: 0,
  };
  const state = { ...base };
  const result = (over: Partial<Result>): Result => ({
    ...state,
    ...over,
    durationMs: now() - started,
  });
  const fail = (detail: string) =>
    result({
      detail: state.changed
        ? `${detail} The site may be partly restored: restore the safety copy to undo.`
        : `${detail} Nothing on the site was changed.`,
    });
  if (!/^[a-z0-9]{1,64}$/.test(job.sourceBackupId)) throw new Error("invalid backup id");
  if (!session.execUpload) return fail("This connection can't stream files.");

  let lastReport = 0;
  const report = async (p: RestoreProgress, force = false) => {
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
    return fail("Google Drive isn't connected. Connect it on the Backups page.");
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key))
    return fail("No backup encryption key in the vault (Settings → Credentials).");
  const drive = new GoogleDrive(
    { clientId, clientSecret, refreshToken },
    deps.fetchImpl,
    deps.sleep,
  );
  const dbFile = `/tmp/ulixops-${job.sourceBackupId}.sql`;
  const wpPath = target.wpPath;
  let touched = false;

  try {
    // 1. The backup is on Drive and opens with the current key, before anything else.
    await report({ phase: "checking", percent: 1 }, true);
    const file = await drive.getFile(job.driveFileId);
    if (!file) return fail("The backup file is no longer on Google Drive.");
    const check = new BackupDecryptor(key);
    let opened = false;
    for await (const piece of drive.download(job.driveFileId)) {
      if (check.push(piece).length > 0) {
        opened = true;
        break;
      }
    }
    if (!opened) check.finish();

    // 2. A safety copy of the site as it is now, so this restore can be undone.
    await report({ phase: "safety", percent: 3 }, true);
    const safety = await runFullBackup(
      session,
      target,
      {
        backupId: job.safetyBackupId,
        folderKey: job.folderKey,
        folderName: job.folderName,
        fileStem: `${job.fileStem}-before-restore`,
        oldFileIds: [],
        ...(job.expectedBytes ? { expectedBytes: job.expectedBytes } : {}),
      },
      secret,
      {
        vault: deps.vault,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        now: deps.now,
        progress: (p) => report({ phase: "safety", percent: 3 + Math.floor(p.percent * 0.37) }),
      },
    );
    if (!safety.ok || !safety.driveFileId || !safety.fileName)
      return fail(`The safety copy failed, so nothing was restored: ${safety.detail}`);
    state.safety = {
      driveFileId: safety.driveFileId,
      fileName: safety.fileName,
      sizeBytes: safety.sizeBytes,
      md5: safety.md5,
      webViewLink: safety.webViewLink,
    };

    // 3. Restore, with visitors seeing the maintenance page meanwhile.
    const doDb = job.scope !== "FILES";
    const doFiles = job.scope !== "DATABASE";
    const dbSpan = doFiles ? 15 : 57;
    const filesFrom = doDb ? 40 + dbSpan : 40;
    let streamed = 0;
    const counter = (phase: "database" | "files", from: number, span: number) => {
      streamed = 0;
      return async (n: number) => {
        streamed += n;
        const share = file.size > 0 ? Math.min(1, streamed / file.size) : 0;
        await report({ phase, percent: from + Math.floor(span * share) });
      };
    };
    touched = true;
    await session
      .exec(toArgv({ op: "maintenance", on: true }, { wpPath }), 60_000)
      .catch(() => undefined);

    if (doDb) {
      await report({ phase: "database", percent: 40 }, true);
      const up = await session.execUpload(
        toArgv({ op: "restore.database", dbFile }),
        plaintext(drive, job.driveFileId, key, counter("database", 40, dbSpan)),
        STREAM_TIMEOUT_MS,
      );
      if (up.exitCode !== 0)
        return fail(
          clean(
            `The database couldn't be taken out of the backup (tar exit ${up.exitCode}): ${up.stderr}`,
          ),
        );
      if (job.rewrite) {
        // Another environment's tables must land where this WordPress looks for them.
        const [dump, here] = await Promise.all([
          session.exec(toArgv({ op: "restore.dump-prefix", dbFile }), 60_000),
          session.exec(toArgv({ op: "db.prefix" }, { wpPath }), 60_000),
        ]);
        const dumpPrefix = /([A-Za-z0-9_]*)options/.exec(dump.stdout)?.[1];
        const sitePrefix = here.stdout.trim();
        if (here.exitCode !== 0)
          return fail(
            clean(
              `Couldn't read this site's table prefix (wp db prefix failed), so the database wasn't restored: ${here.stderr || here.stdout || `exit ${here.exitCode}`}`,
            ),
          );
        if (dumpPrefix === undefined)
          return fail(
            clean(
              `Couldn't find a …options table in the backup dump, so the database wasn't restored (dump check exit ${dump.exitCode}): ${dump.stderr || dump.stdout || "no match"}`,
            ),
          );
        if (dumpPrefix !== sitePrefix)
          return fail(
            clean(
              `The backup's tables start with "${dumpPrefix}" but this site's with "${sitePrefix}", so the database wasn't restored. Match $table_prefix in wp-config.php first.`,
            ),
          );
        // Drop tables that exist only on this environment before the other dump lands (A174).
        const reset = await session.exec(toArgv({ op: "db.reset" }, { wpPath }), IMPORT_TIMEOUT_MS);
        if (reset.exitCode !== 0)
          return fail(
            clean(
              `Couldn't clear this environment's database before the copy, so nothing was imported: ${reset.stderr || reset.stdout || `exit ${reset.exitCode}`}`,
            ),
          );
        state.changed = true;
      }
      state.changed = true;
      const imported = await session.exec(
        toArgv({ op: "db.import", file: dbFile }, { wpPath }),
        IMPORT_TIMEOUT_MS,
      );
      if (imported.exitCode !== 0)
        return fail(clean(`The database import failed: ${imported.stderr || imported.stdout}`));
      state.database = true;
      if (job.rewrite && job.rewrite.from !== job.rewrite.to) {
        for (const escaped of [false, true]) {
          const replaced = await session.exec(
            toArgv(
              { op: "db.search-replace", from: job.rewrite.from, to: job.rewrite.to, escaped },
              { wpPath },
            ),
            IMPORT_TIMEOUT_MS,
          );
          if (replaced.exitCode !== 0)
            return fail(
              clean(
                `The database was restored, but changing the site address from ${job.rewrite.from} to ${job.rewrite.to} failed: ${replaced.stderr || replaced.stdout}`,
              ),
            );
        }
      }
    }

    if (doFiles) {
      await report({ phase: "files", percent: filesFrom }, true);
      if (job.rewrite) {
        const cleared = await session.exec(
          toArgv({ op: "restore.clear-content", wpPath }),
          120_000,
        );
        if (cleared.exitCode !== 0)
          return fail(
            clean(
              `Couldn't remove this environment's plugins, themes and uploads before the copy: ${cleared.stderr || cleared.stdout || `exit ${cleared.exitCode}`}`,
            ),
          );
        state.changed = true;
      }
      state.changed = true;
      const up = await session.execUpload(
        toArgv({ op: "restore.files", wpPath, dbFile, wpContent: job.scope === "FILES" }),
        plaintext(drive, job.driveFileId, key, counter("files", filesFrom, 97 - filesFrom)),
        STREAM_TIMEOUT_MS,
      );
      const lines = up.stderr
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const onlyPerFile = lines.every((l) => PER_FILE.test(l) || SUMMARY.test(l));
      if (!up.consumed || up.exitCode === -1 || (up.exitCode !== 0 && !onlyPerFile))
        return fail(
          clean(
            `Extracting the files failed (tar exit ${up.exitCode}): ${up.stderr || "stopped early"}`,
          ),
        );
      state.warnings = lines
        .filter((l) => PER_FILE.test(l))
        .slice(0, 10)
        .map((l) => clean(l).slice(0, 300));
      state.files = true;
    }

    await report({ phase: "finishing", percent: 98 }, true);
    await session.exec(toArgv({ op: "cache.flush" }, { wpPath }), 60_000).catch(() => undefined);
    const what =
      job.scope === "ALL"
        ? "the database and files"
        : job.scope === "DATABASE"
          ? "the database"
          : "wp-content";
    const skipped = state.warnings.length
      ? ` ${state.warnings.length} file${state.warnings.length === 1 ? "" : "s"} the host keeps read-only couldn't be replaced.`
      : "";
    const moved =
      job.rewrite && state.database && job.rewrite.from !== job.rewrite.to
        ? ` Site address in the database changed from ${job.rewrite.from} to ${job.rewrite.to}.`
        : "";
    const wiped =
      job.rewrite && state.database && state.files
        ? " The previous database, plugins, themes and uploads were removed first."
        : job.rewrite && state.database
          ? " The previous database was cleared first."
          : job.rewrite && state.files
            ? " Plugins, themes and uploads that existed only here were removed first."
            : "";
    return result({
      ok: true,
      detail: `Restored ${what} from the backup.${moved}${wiped}${skipped}`,
    });
  } catch (error) {
    if (error instanceof DriveAuthError || error instanceof DriveError)
      return fail(clean(error.message));
    if (error instanceof BackupDecryptError) return fail(error.message);
    return fail(
      clean(`The restore stopped: ${error instanceof Error ? error.message : String(error)}`),
    );
  } finally {
    // Leave the site out of maintenance, and the dump never stays in /tmp.
    if (touched) await restoreCleanup(session, wpPath, dbFile);
  }
}

async function restoreCleanup(session: SshSession, wpPath: string, dbFile: string) {
  await session
    .exec(toArgv({ op: "maintenance", on: false }, { wpPath }), 60_000)
    .catch(() => undefined);
  try {
    const fs = await session.sftp();
    await clearMaintenanceFile(fs, wpPath).catch(() => false);
    await fs.unlink(dbFile).catch(() => undefined);
    fs.close();
  } catch {
    // best effort
  }
}
