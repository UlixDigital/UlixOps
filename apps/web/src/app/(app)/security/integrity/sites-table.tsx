"use client";
// Every environment's last file integrity check, with Check now (A144).
import type { IntegritySiteRow } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import { ActionForm } from "@/components/action-form";
import { DataTable } from "@/components/data-table";
import { EnvBadge } from "@/components/env-badge";
import { IntegrityBadge } from "@/components/integrity-card";
import { formatUtc, timeAgo } from "@/lib/format";
import { startIntegrityCheckAction } from "./actions";

const RANK = { CHANGED: 0, FAILED: 1, CLEAN: 3 } as const;

export function IntegritySitesTable({
  rows,
  canCheck,
}: {
  rows: IntegritySiteRow[];
  canCheck: boolean;
}) {
  const columns = useMemo<ColumnDef<IntegritySiteRow>[]>(
    () => [
      {
        id: "site",
        header: "Site",
        accessorFn: (r) => r.siteName,
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/sites/${row.original.siteId}/security`}
              className="font-medium hover:underline"
            >
              {row.original.siteName}
            </Link>
            {row.original.environment === "STAGING" && <EnvBadge kind="STAGING" />}
          </span>
        ),
      },
      {
        id: "result",
        header: "Last result",
        accessorFn: (r) => (r.running ? 2 : r.last ? RANK[r.last.status as keyof typeof RANK] : 4),
        cell: ({ row }) => {
          const r = row.original;
          if (r.running) return <IntegrityBadge status="RUNNING" />;
          if (!r.last)
            return (
              <span className="text-muted-foreground">
                {r.ready ? "Not checked yet" : "Connection not tested"}
              </span>
            );
          return (
            <Link href={`/security/integrity/${r.last.id}`} className="flex items-center gap-1.5">
              <IntegrityBadge status={r.last.status} />
              {r.last.findingCount > 0 && (
                <span className="text-xs text-destructive">
                  {r.last.findingCount} file{r.last.findingCount === 1 ? "" : "s"}
                </span>
              )}
            </Link>
          );
        },
      },
      {
        id: "unverifiable",
        header: "Not verifiable",
        accessorFn: (r) => r.last?.unverifiable ?? -1,
        cell: ({ row }) =>
          row.original.last && row.original.last.unverifiable > 0 ? (
            <span
              className="text-xs text-muted-foreground"
              title="Premium or custom plugins: WordPress.org has no checksums for them"
            >
              {row.original.last.unverifiable} plugin
              {row.original.last.unverifiable === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "checked",
        header: "Last checked",
        accessorFn: (r) => r.last?.at ?? "",
        cell: ({ row }) =>
          row.original.last ? (
            <span
              className="text-xs whitespace-nowrap text-muted-foreground"
              title={formatUtc(row.original.last.at)}
            >
              {timeAgo(row.original.last.at)}
              {!row.original.autoScan && " · auto off"}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) =>
          canCheck && row.original.ready && !row.original.running ? (
            <div className="flex justify-end">
              <ActionForm
                action={startIntegrityCheckAction}
                submitLabel="Check now"
                variant="outline"
              >
                <input type="hidden" name="siteId" value={row.original.siteId} />
                <input type="hidden" name="kind" value={row.original.environment} />
              </ActionForm>
            </div>
          ) : null,
      },
    ],
    [canCheck],
  );
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchLabel="Search sites"
      emptyText="No sites."
      initialSorting={[{ id: "result", desc: false }]}
    />
  );
}
