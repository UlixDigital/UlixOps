"use client";
// Finished full backups, newest first (A145).
import type { FullBackupView } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { BackupBadge } from "@/components/backup-badge";
import { DataTable } from "@/components/data-table";
import { EnvBadge } from "@/components/env-badge";
import { formatBytes } from "@/lib/backups";
import { formatUtc } from "@/lib/format";
import { scanDuration } from "@/lib/malware";

const columns: ColumnDef<FullBackupView>[] = [
  {
    id: "started",
    header: "Started (UTC)",
    accessorFn: (b) => b.startedAt,
    cell: ({ row }) => (
      <span className="text-sm whitespace-nowrap">{formatUtc(row.original.startedAt)}</span>
    ),
  },
  {
    id: "site",
    header: "Site",
    accessorFn: (b) => `${b.siteName} ${b.environment}`,
    cell: ({ row }) => (
      <span className="flex flex-wrap items-center gap-1.5">
        {row.original.siteName}
        {row.original.environment === "STAGING" && <EnvBadge kind="STAGING" />}
      </span>
    ),
  },
  {
    id: "status",
    header: "Result",
    accessorFn: (b) => b.status,
    cell: ({ row }) => (
      <span className="grid gap-0.5">
        <BackupBadge status={row.original.status} />
        {row.original.detail &&
          row.original.status !== "READY" &&
          row.original.status !== "REMOVED" && (
            <span className="max-w-xs text-xs text-muted-foreground">{row.original.detail}</span>
          )}
      </span>
    ),
  },
  {
    id: "size",
    header: "Size",
    accessorFn: (b) => b.bytes,
    cell: ({ row }) =>
      row.original.status === "READY" || row.original.status === "REMOVED" ? (
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {formatBytes(row.original.bytes)}
          {row.original.status === "READY" && row.original.webViewLink && (
            <>
              {" · "}
              <a
                href={row.original.webViewLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link hover:underline"
              >
                Open
              </a>
            </>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: "took",
    header: "Took",
    accessorFn: (b) => (b.finishedAt ? Date.parse(b.finishedAt) - Date.parse(b.startedAt) : 0),
    cell: ({ row }) => (
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        {scanDuration(row.original)}
      </span>
    ),
  },
  {
    id: "by",
    header: "Started by",
    accessorFn: (b) => b.requestedBy ?? "schedule",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.requestedBy ?? "Weekly schedule"}
        {row.original.cancelledBy ? ` · stopped by ${row.original.cancelledBy}` : ""}
      </span>
    ),
  },
];

export function BackupHistoryTable({ backups }: { backups: FullBackupView[] }) {
  return (
    <DataTable
      columns={columns}
      data={backups}
      searchLabel="Search backups"
      emptyText="No finished backups match."
      initialSorting={[{ id: "started", desc: true }]}
    />
  );
}
