// Full backup status badge and progress bar (A145).
import type { FullBackupView } from "@ulixops/shared";
import { BACKUP_PHASE, BACKUP_STATUS, formatBytes } from "@/lib/backups";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export function BackupBadge({ status }: { status: FullBackupView["status"] }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        BACKUP_STATUS[status].tone,
      )}
    >
      {BACKUP_STATUS[status].label}
    </span>
  );
}

export function BackupProgress({ backup }: { backup: FullBackupView }) {
  const phase = backup.phase ?? "database";
  const percent = backup.progress;
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{BACKUP_PHASE[phase]}…</span>
        <span className="font-mono tabular-nums">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`Backup of ${backup.siteName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150"
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {phase === "uploading" ? `${formatBytes(backup.bytes)} uploaded · ` : ""}started{" "}
        {timeAgo(backup.startedAt)}
        {phase === "uploading" ? " · percentage estimated from the last backup's size" : ""}
      </p>
    </div>
  );
}
