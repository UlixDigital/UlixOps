"use client";
// Every environment's backup on Drive, last problem, next run and actions (A145).
import type { FullBackupSiteRow } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import { ActionForm } from "@/components/action-form";
import { BackupBadge } from "@/components/backup-badge";
import { buttonVariants } from "@/components/ui/button";
import { DataTable } from "@/components/data-table";
import { EnvBadge } from "@/components/env-badge";
import { formatBytes } from "@/lib/backups";
import { formatUtc, timeAgo } from "@/lib/format";
import { backupNowAction, setBackupAutoAction } from "./actions";

export function BackupSitesTable({
  rows,
  canRun,
  canManage,
  canRestore,
  driveReady,
}: {
  rows: FullBackupSiteRow[];
  canRun: boolean;
  canManage: boolean;
  canRestore: boolean;
  driveReady: boolean;
}) {
  const columns = useMemo<ColumnDef<FullBackupSiteRow>[]>(
    () => [
      {
        id: "site",
        header: "Site",
        accessorFn: (r) => r.siteName,
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <Link href={`/sites/${row.original.siteId}`} className="font-medium hover:underline">
              {row.original.siteName}
            </Link>
            {row.original.environment === "STAGING" && <EnvBadge kind="STAGING" />}
          </span>
        ),
      },
      {
        id: "backup",
        header: "Backup on Drive",
        // Problems and missing backups first when sorted ascending.
        accessorFn: (r) => (r.lastProblem ? 0 : r.current ? 2 : 1),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="grid gap-0.5">
              {r.pending ? (
                <BackupBadge status={r.pending.status} />
              ) : r.current ? (
                <span className="text-xs" title={formatUtc(r.current.at)}>
                  {timeAgo(r.current.at)} · {formatBytes(r.current.bytes)}
                  {r.current.webViewLink && (
                    <>
                      {" · "}
                      <a
                        href={r.current.webViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-link hover:underline"
                      >
                        Open in Drive
                      </a>
                    </>
                  )}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {r.ready ? "None yet" : "Connection not tested"}
                </span>
              )}
              {r.lastProblem && (
                <span className="flex items-center gap-1" title={r.lastProblem.detail ?? undefined}>
                  <BackupBadge status={r.lastProblem.status} />
                  <span className="text-xs text-muted-foreground">{timeAgo(r.lastProblem.at)}</span>
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: "next",
        header: "Next weekly backup",
        accessorFn: (r) => r.nextAutoAt ?? "~",
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            {!row.original.autoBackup
              ? "Off for this site"
              : row.original.nextAutoAt
                ? formatUtc(row.original.nextAutoAt)
                : "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {canManage && (
                <ActionForm
                  action={setBackupAutoAction}
                  submitLabel={r.autoBackup ? "Weekly: on" : "Weekly: off"}
                  variant="outline"
                >
                  <input type="hidden" name="siteId" value={r.siteId} />
                  <input type="hidden" name="kind" value={r.environment} />
                  <input type="hidden" name="enabled" value={r.autoBackup ? "false" : "true"} />
                </ActionForm>
              )}
              {canRun && driveReady && r.ready && !r.pending && (
                <ActionForm action={backupNowAction} submitLabel="Back up now" variant="outline">
                  <input type="hidden" name="siteId" value={r.siteId} />
                  <input type="hidden" name="kind" value={r.environment} />
                </ActionForm>
              )}
              {canRestore && r.current && (
                <Link
                  href={`/backups/restore?backup=${r.current.id}`}
                  className={buttonVariants({ variant: "outline" })}
                >
                  Restore
                </Link>
              )}
            </div>
          );
        },
      },
    ],
    [canRun, canManage, canRestore, driveReady],
  );
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchLabel="Search sites"
      emptyText="No sites."
      initialSorting={[{ id: "backup", desc: false }]}
    />
  );
}
