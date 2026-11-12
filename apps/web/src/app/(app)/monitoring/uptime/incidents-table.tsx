"use client";
// Outage history (A149): ongoing incidents first, then newest.
import type { UptimeIncidentView } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import { durationBetween } from "@/components/uptime-badge";
import { formatUtc } from "@/lib/format";
import { cn } from "@/lib/utils";

export function IncidentsTable({
  rows,
  showSite = true,
}: {
  rows: UptimeIncidentView[];
  showSite?: boolean;
}) {
  const columns = useMemo<ColumnDef<UptimeIncidentView>[]>(
    () => [
      ...(showSite
        ? [
            {
              id: "site",
              header: "Site",
              accessorFn: (r: UptimeIncidentView) => r.siteName,
              cell: ({ row }: { row: { original: UptimeIncidentView } }) => (
                <Link
                  href={`/sites/${row.original.siteId}/monitoring`}
                  className="font-medium hover:underline"
                >
                  {row.original.siteName}
                </Link>
              ),
            } satisfies ColumnDef<UptimeIncidentView>,
          ]
        : []),
      {
        id: "started",
        header: "Started",
        // Ongoing first, then newest.
        accessorFn: (r) => (r.endedAt ? Date.parse(r.startedAt) : Number.MAX_SAFE_INTEGER),
        cell: ({ row }) => (
          <span className="text-sm whitespace-nowrap tabular-nums">
            {formatUtc(row.original.startedAt)}
          </span>
        ),
      },
      {
        id: "duration",
        header: "Down for",
        accessorFn: (r) =>
          Date.parse(r.endedAt ?? new Date().toISOString()) - Date.parse(r.startedAt),
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="flex flex-wrap items-center gap-1.5 text-sm whitespace-nowrap">
              {durationBetween(r.startedAt, r.endedAt)}
              <span
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-xs font-medium",
                  !r.endedAt
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {!r.endedAt
                  ? "Ongoing"
                  : r.endReason === "paused"
                    ? "Monitoring paused"
                    : "Recovered"}
              </span>
            </span>
          );
        },
      },
      {
        id: "reason",
        header: "Reason",
        accessorFn: (r) => r.error ?? "",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.error ?? "—"} · {row.original.failedChecks} failed check
            {row.original.failedChecks === 1 ? "" : "s"}
          </span>
        ),
      },
    ],
    [showSite],
  );
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchLabel="Search incidents"
      emptyText="No downtime in the last 30 days."
      initialSorting={[{ id: "started", desc: true }]}
    />
  );
}
