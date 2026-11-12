// Display helpers for full backups (A145). Plain functions, safe on the server and the client.
import type { FullBackupView, RestoreView } from "@ulixops/shared";

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const BACKUP_STATUS: Record<FullBackupView["status"], { label: string; tone: string }> = {
  QUEUED: { label: "Queued", tone: "bg-muted text-muted-foreground" },
  RUNNING: { label: "Backing up…", tone: "bg-primary/10 text-primary" },
  READY: { label: "On Drive", tone: "bg-success/10 text-success" },
  FAILED: { label: "Failed", tone: "bg-destructive/10 text-destructive" },
  SKIPPED: { label: "Skipped (site unhealthy)", tone: "bg-warning/10 text-warning" },
  CANCELLED: { label: "Stopped", tone: "bg-muted text-muted-foreground" },
  REMOVED: { label: "Replaced", tone: "bg-muted text-muted-foreground" },
};

export const BACKUP_PHASE: Record<NonNullable<FullBackupView["phase"]>, string> = {
  database: "Checking the site and dumping the database",
  uploading: "Uploading the site to Google Drive",
  verifying: "Verifying the copy on Drive",
  cleanup: "Removing last week's backup",
};

/** Restore from Google Drive (A152). */
export const RESTORE_STATUS: Record<RestoreView["status"], { label: string; tone: string }> = {
  PENDING_APPROVAL: { label: "Waiting for approval", tone: "bg-warning/10 text-warning" },
  QUEUED: { label: "Approved, queued", tone: "bg-muted text-muted-foreground" },
  RUNNING: { label: "Restoring…", tone: "bg-primary/10 text-primary" },
  SUCCEEDED: { label: "Restored", tone: "bg-success/10 text-success" },
  FAILED: { label: "Failed", tone: "bg-destructive/10 text-destructive" },
  REJECTED: { label: "Rejected", tone: "bg-muted text-muted-foreground" },
  CANCELLED: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
};

export const RESTORE_PHASE: Record<NonNullable<RestoreView["phase"]>, string> = {
  checking: "Checking the backup opens with the key",
  safety: "Saving a safety copy of the site as it is now",
  database: "Restoring the database",
  files: "Restoring the files",
  finishing: "Flushing caches and ending maintenance mode",
};
