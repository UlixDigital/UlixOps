"use client";
// Every production site's uptime (A149): down first, then the lowest uptime.
import type { UptimeSiteView } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import { msText, percentText, percentTone, UptimeBadge } from "@/components/uptime-badge";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Down first, then up with a failing last check, up, not checked, paused. */
function rank(s: UptimeSiteView): number {
  if (s.state === "down") return 0;
  if (s.state === "up") return s.error ? 1 : 2;
  return s.state === "unknown" ? 3 : 4;
}

function percentCell(percent: number | null) {
  return (
    <span className={cn("text-sm whitespace-nowrap tabular-nums", percentTone(percent))}>
      {percentText(percent)}
    </span>
  );
}

export function UptimeTable({ rows }: { rows: UptimeSiteView[] }) {
  const columns = useMemo<ColumnDef<UptimeSiteView>[]>(
    () => [
      {
        id: "site",
        header: "Site",
        accessorFn: (r) => `${r.siteName} ${r.url}`,
        cell: ({ row }) => (
          <span className="grid gap-0.5">
            <Link
              href={`/sites/${row.original.siteId}/monitoring`}
              className="font-medium hover:underline"
            >
              {row.original.siteName}
            </Link>
            <span className="text-xs break-all text-muted-foreground">
              {row.original.url.replace(/^https?:\/\//, "")}
            </span>
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: rank,
        cell: ({ row }) => {
          const s = row.original;
          return (
            <span className="grid gap-1">
              <UptimeBadge state={s.state} since={s.downSince} />
              {s.error && s.state !== "paused" && (
                <span className="max-w-64 text-xs text-destructive">
                  {s.state === "up" ? `Last check failed (${s.error}); checking again` : s.error}
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: "response",
        header: "Response",
        accessorFn: (r) => r.responseMs ?? Number.MAX_SAFE_INTEGER,
        cell: ({ row }) => (
          <span className="text-sm whitespace-nowrap tabular-nums">
            {row.original.error ? "—" : msText(row.original.responseMs)}
          </span>
        ),
      },
      {
        id: "day",
        header: "24 h",
        accessorFn: (r) => r.day.percent ?? 101,
        cell: ({ row }) => percentCell(row.original.day.percent),
      },
      {
        id: "week",
        header: "7 days",
        accessorFn: (r) => r.week.percent ?? 101,
        cell: ({ row }) => percentCell(row.original.week.percent),
      },
      {
        id: "month",
        header: "30 days",
        accessorFn: (r) => r.month.percent ?? 101,
        cell: ({ row }) => percentCell(row.original.month.percent),
      },
      {
        id: "checked",
        header: "Checked",
        accessorFn: (r) => r.checkedAt ?? "",
        cell: ({ row }) => (
          <span
            className="text-xs whitespace-nowrap text-muted-foreground"
            title={formatUtc(row.original.checkedAt)}
          >
            {row.original.checkedAt ? timeAgo(row.original.checkedAt) : "—"}
          </span>
        ),
      },
    ],
    [],
  );
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchLabel="Search sites"
      emptyText="No active sites yet."
      initialSorting={[{ id: "status", desc: false }]}
    />
  );
}
