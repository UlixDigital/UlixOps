// Full backups to Google Drive (Phase 2 step 5, A145): weekly, encrypted, one copy per site
// (the previous one is deleted permanently once the new one is verified on Drive).
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();
const Env = z.enum(["PRODUCTION", "STAGING"]);

/** Vault names for the Drive connection and the backup key (values never leave the runner). */
export const DRIVE_CLIENT_ID_REF = "GOOGLE_DRIVE_CLIENT_ID";
export const DRIVE_CLIENT_SECRET_REF = "GOOGLE_DRIVE_CLIENT_SECRET";
export const DRIVE_REFRESH_TOKEN_REF = "GOOGLE_DRIVE_REFRESH_TOKEN";
export const BACKUP_KEY_REF = "BACKUP_ENCRYPTION_KEY";

/** A Drive file id. */
export const DriveFileId = z.string().regex(/^[A-Za-z0-9_-]{5,200}$/);

// ---- Runner jobs ---------------------------------------------------------------------------

export const FullBackupPhase = z.enum(["database", "uploading", "verifying", "cleanup"]);
export type FullBackupPhase = z.infer<typeof FullBackupPhase>;

export const FullBackupProgress = z.object({
  phase: FullBackupPhase,
  percent: z.number().int().min(0).max(100),
  /** Encrypted bytes uploaded so far. */
  bytes: z.number().int().nonnegative(),
});
export type FullBackupProgress = z.infer<typeof FullBackupProgress>;

export const FullBackupJobResult = z.discriminatedUnion("hostKeyMismatch", [
  z.object({ hostKeyMismatch: z.literal(true), presented: z.string() }),
  z.object({
    hostKeyMismatch: z.literal(false),
    hostKey: z.string(),
    ok: z.boolean(),
    cancelled: z.boolean().optional(),
    driveFileId: DriveFileId.nullable(),
    fileName: z.string().max(300).nullable(),
    sizeBytes: z.number().int().nonnegative(),
    md5: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    webViewLink: z.string().max(500).nullable(),
    /** Older backups deleted from Drive (permanently) after this one was verified. */
    removed: z.array(DriveFileId).max(50),
    removeFailed: z.array(DriveFileId).max(50),
    detail: z.string().max(2000),
    durationMs: z.number(),
  }),
]);
export type FullBackupJobResult = z.infer<typeof FullBackupJobResult>;

export const DriveStatusResult = z.object({
  setup: z.object({ clientId: z.boolean(), clientSecret: z.boolean(), key: z.boolean() }),
  connected: z.boolean(),
  email: z.string().nullable(),
  limit: z.number().nullable(),
  usage: z.number().nullable(),
  /** Why Drive can't be used right now, in plain words. */
  error: z.string().max(500).nullable(),
});
export type DriveStatusResult = z.infer<typeof DriveStatusResult>;

/** `drive.auth.start`: Google's sign-in page for this hub, and the state that ties the reply. */
export const DriveAuthStart = z.object({
  authUrl: z.url({ protocol: /^https$/ }).max(2000),
  state: z.string().regex(/^[a-f0-9]{32}$/),
});
export type DriveAuthStart = z.infer<typeof DriveAuthStart>;

/** What Google sends back to /oauth/google/callback (validated before it goes anywhere). */
export const GoogleAuthCode = z.string().regex(/^[A-Za-z0-9/_.~-]{10,2000}$/);
export const DriveAuthState = z.string().regex(/^[a-f0-9]{32}$/);
export const DriveAuthFinishRequest = z.object({ state: DriveAuthState, code: GoogleAuthCode });

export const DriveAuthFinish = z.object({
  status: z.enum(["connected", "failed", "unknown"]),
  email: z.string().nullable(),
  detail: z.string().max(500),
});
export type DriveAuthFinish = z.infer<typeof DriveAuthFinish>;

// ---- Schedule and views --------------------------------------------------------------------

/** Weekly automatic backups (Backups → Full backups → Schedule). Times are UTC. */
export const BackupSchedule = z.object({
  enabled: z.boolean(),
  /** 0 = Sunday … 5 = Friday … 6 = Saturday. */
  dayOfWeek: z.number().int().min(0).max(6),
  startHourUtc: z.number().int().min(0).max(23),
  /** Backups only start inside this window (they can run past its end). */
  windowHours: z.number().int().min(1).max(24),
  includeStaging: z.boolean(),
});
export type BackupSchedule = z.infer<typeof BackupSchedule>;

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  enabled: true,
  dayOfWeek: 5,
  startHourUtc: 18,
  windowHours: 8,
  includeStaging: false,
};

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** True when `at` is on the scheduled day inside the window (a window may run past midnight). */
export function inBackupWindow(s: BackupSchedule, at: Date): boolean {
  const start = new Date(at);
  start.setUTCHours(s.startHourUtc, 0, 0, 0);
  for (let back = 0; back <= 1; back++) {
    const candidate = new Date(start.getTime() - back * 86_400_000);
    if (candidate.getUTCDay() !== s.dayOfWeek) continue;
    const t = at.getTime() - candidate.getTime();
    if (t >= 0 && t < s.windowHours * 3_600_000) return true;
  }
  return false;
}

/** The next start of the backup window at or after `at`. */
export function nextBackupWindow(s: BackupSchedule, at: Date): Date {
  if (inBackupWindow(s, at)) return at;
  const d = new Date(at);
  d.setUTCHours(s.startHourUtc, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (d.getUTCDay() === s.dayOfWeek && d.getTime() > at.getTime()) return d;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

export const FullBackupStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "READY",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
  "REMOVED",
]);
export type FullBackupStatus = z.infer<typeof FullBackupStatus>;

/** WEEKLY: the schedule or "Back up now". SAFETY: taken just before a restore (A152). */
export const FullBackupPurpose = z.enum(["WEEKLY", "SAFETY"]);
export type FullBackupPurpose = z.infer<typeof FullBackupPurpose>;

export const FullBackupView = z.object({
  id,
  siteId: id,
  siteName: z.string(),
  environment: Env,
  status: FullBackupStatus,
  queuedAt: iso,
  startedAt: iso,
  finishedAt: iso.nullable(),
  requestedBy: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  phase: FullBackupPhase.nullable(),
  progress: z.number().int().min(0).max(100),
  /** Uploaded so far (running) or the final file size. */
  bytes: z.number().nonnegative(),
  fileName: z.string().nullable(),
  webViewLink: z.string().nullable(),
  detail: z.string().nullable(),
  removedAt: iso.nullable(),
  purpose: FullBackupPurpose,
  /** Safety copies are deleted from Drive at this time. */
  expiresAt: iso.nullable(),
});
export type FullBackupView = z.infer<typeof FullBackupView>;

export const FullBackupList = z.object({ backups: z.array(FullBackupView) });
export type FullBackupList = z.infer<typeof FullBackupList>;

export const FullBackupSiteRow = z.object({
  siteId: id,
  siteName: z.string(),
  environment: Env,
  ready: z.boolean(),
  autoBackup: z.boolean(),
  /** The copy on Drive now. */
  current: z
    .object({
      id,
      at: iso,
      bytes: z.number().nonnegative(),
      fileName: z.string().nullable(),
      webViewLink: z.string().nullable(),
    })
    .nullable(),
  /** The latest finished attempt, when it didn't produce a copy. */
  lastProblem: z
    .object({ id, status: FullBackupStatus, at: iso, detail: z.string().nullable() })
    .nullable(),
  pending: z.object({ id, status: z.enum(["QUEUED", "RUNNING"]) }).nullable(),
  nextAutoAt: iso.nullable(),
  /** The site's last health check (any source, including a backup's own check); null = never. */
  health: z.object({ ok: z.boolean(), at: iso, summary: z.string().nullable() }).nullable(),
});
export type FullBackupSiteRow = z.infer<typeof FullBackupSiteRow>;

export const DriveView = DriveStatusResult.extend({
  /** When it was connected, from the hub's records. */
  connectedAt: iso.nullable(),
  /** The address to add as an authorized redirect URI on the Google OAuth client. */
  redirectUri: z.string(),
});
export type DriveView = z.infer<typeof DriveView>;

export const FullBackupOverview = z.object({
  drive: DriveView,
  running: FullBackupView.nullable(),
  queue: z.array(FullBackupView),
  schedule: BackupSchedule,
  sites: z.array(FullBackupSiteRow),
  stats: z.object({
    protected: z.number().int(),
    problems: z.number().int(),
    never: z.number().int(),
    totalBytes: z.number().nonnegative(),
    lastFinishedAt: iso.nullable(),
  }),
});
export type FullBackupOverview = z.infer<typeof FullBackupOverview>;

export const SetBackupAuto = z.object({ enabled: z.boolean() });

// ---- Restore from Google Drive (A152) ------------------------------------------------------

/** How long a "before restore" safety copy stays on Drive. */
export const SAFETY_COPY_DAYS = 7;

/** ALL: database + every file except wp-config.php. FILES: wp-content only. */
export const RestoreScope = z.enum(["ALL", "DATABASE", "FILES"]);
export type RestoreScope = z.infer<typeof RestoreScope>;

export const RESTORE_SCOPE_LABELS: Record<RestoreScope, string> = {
  ALL: "Everything (database and files)",
  DATABASE: "Database only",
  FILES: "Files only (wp-content)",
};

export const RestorePhase = z.enum(["checking", "safety", "database", "files", "finishing"]);
export type RestorePhase = z.infer<typeof RestorePhase>;

export const RestoreProgress = z.object({
  phase: RestorePhase,
  percent: z.number().int().min(0).max(100),
});
export type RestoreProgress = z.infer<typeof RestoreProgress>;

const SafetyCopy = z.object({
  driveFileId: DriveFileId,
  fileName: z.string().max(300),
  sizeBytes: z.number().int().nonnegative(),
  md5: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .nullable(),
  webViewLink: z.string().max(500).nullable(),
});

export const RestoreJobResult = z.discriminatedUnion("hostKeyMismatch", [
  z.object({ hostKeyMismatch: z.literal(true), presented: z.string() }),
  z.object({
    hostKeyMismatch: z.literal(false),
    hostKey: z.string(),
    ok: z.boolean(),
    /** The safety copy on Drive, when it was made. */
    safety: SafetyCopy.nullable(),
    /** Something on the site was overwritten (so it needs a health check, and maybe the copy). */
    changed: z.boolean(),
    database: z.boolean(),
    files: z.boolean(),
    /** Files tar couldn't write (host-managed, read-only); the rest was restored. */
    warnings: z.array(z.string().max(300)).max(10),
    detail: z.string().max(2000),
    durationMs: z.number(),
  }),
]);
export type RestoreJobResult = z.infer<typeof RestoreJobResult>;

export const DriveDeleteResult = z.object({
  deleted: z.array(DriveFileId).max(50),
  failed: z.array(DriveFileId).max(50),
});
export type DriveDeleteResult = z.infer<typeof DriveDeleteResult>;

export const RestoreStatus = z.enum([
  "PENDING_APPROVAL",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
]);
export type RestoreStatus = z.infer<typeof RestoreStatus>;

/**
 * Start a restore: the backup, what to restore, and the site's name typed to confirm. `target`
 * is the environment to overwrite; it defaults to the backup's own, and may be the site's other
 * environment (production backup → staging, or back), A157.
 */
export const StartRestoreRequest = z.object({
  backupId: id,
  scope: RestoreScope,
  confirmName: z.string().trim().min(1).max(200),
  target: Env.optional(),
});
export type StartRestoreRequest = z.infer<typeof StartRestoreRequest>;

/** A backup on Drive that can be restored. */
export const RestoreSource = z.object({
  backupId: id,
  siteId: id,
  siteName: z.string(),
  environment: Env,
  purpose: FullBackupPurpose,
  at: iso,
  bytes: z.number().nonnegative(),
  fileName: z.string().nullable(),
  webViewLink: z.string().nullable(),
  expiresAt: iso.nullable(),
});
export type RestoreSource = z.infer<typeof RestoreSource>;

export const RestoreView = z.object({
  id,
  siteId: id,
  siteName: z.string(),
  /** The environment that was (or will be) overwritten. */
  environment: Env,
  /** Where the backup came from: differs from `environment` for a copy across (A157). */
  sourceEnvironment: Env,
  status: RestoreStatus,
  scope: RestoreScope,
  source: z.object({
    backupId: id,
    purpose: FullBackupPurpose,
    at: iso,
    fileName: z.string().nullable(),
  }),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  createdAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  phase: RestorePhase.nullable(),
  progress: z.number().int().min(0).max(100),
  detail: z.string().nullable(),
  /** The "before restore" copy: restoring it undoes this restore. */
  safety: z
    .object({
      backupId: id,
      status: FullBackupStatus,
      webViewLink: z.string().nullable(),
      expiresAt: iso.nullable(),
    })
    .nullable(),
  health: z.object({ ok: z.boolean(), summary: z.string().nullable() }).nullable(),
});
export type RestoreView = z.infer<typeof RestoreView>;

/** An environment a restore can overwrite (A157). */
export const RestoreTarget = z.object({
  siteId: id,
  siteName: z.string(),
  environment: Env,
  url: z.string(),
  /** Connection tested (pinned host key); a restore needs it. */
  ready: z.boolean(),
});
export type RestoreTarget = z.infer<typeof RestoreTarget>;

export const RestoreOverview = z.object({
  driveConnected: z.boolean(),
  sources: z.array(RestoreSource),
  targets: z.array(RestoreTarget),
  restores: z.array(RestoreView),
});
export type RestoreOverview = z.infer<typeof RestoreOverview>;
