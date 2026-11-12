"use client";
// Every site's PHP error log at a glance (A159): fatal / errors / warnings in 24 h, newest error.
import type { ErrorLogRow } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { DataTable } from "@/components/data-table";
import { EnvBadge } from "@/components/env-badge";
import { LevelBadge, LoggingBadge, sourceText } from "@/components/php-errors";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const count = (n: number, tone: string) =>
  n === 0 ? (
    <span className="text-muted-foreground">0</span>
  ) : (
    <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums", tone)}>
      {n}
    </span>
  );

const columns: ColumnDef<ErrorLogRow>[] = [
  {
    id: "site",
    header: "Site",
    accessorFn: (r) => r.siteName,
    cell: ({ row }) => (
      <span className="flex flex-wrap items-center gap-1.5">
        <Link
          href={`/sites/${row.original.siteId}/logs${row.original.environment === "STAGING" ? "?env=staging" : ""}`}
          className="font-medium hover:underline"
        >
          {row.original.siteName}
        </Link>
        {row.original.environment === "STAGING" && <EnvBadge kind="STAGING" />}
      </span>
    ),
  },
  {
    id: "fatal",
    header: "Fatal, 24 h",
    accessorFn: (r) => r.fatal24h,
    cell: ({ row }) => count(row.original.fatal24h, "bg-destructive/10 text-destructive"),
  },
  {
    id: "errors",
    header: "Errors, 24 h",
    accessorFn: (r) => r.errors24h,
    cell: ({ row }) => count(row.original.errors24h, "bg-destructive/10 text-destructive"),
  },
  {
    id: "warnings",
    header: "Warnings, 24 h",
    accessorFn: (r) => r.warnings24h,
    cell: ({ row }) => count(row.original.warnings24h, "bg-warning/10 text-warning"),
  },
  {
    id: "top",
    header: "Newest serious error",
    accessorFn: (r) => r.top?.message ?? "",
    cell: ({ row }) => {
      const r = row.original;
      if (!r.readAt) return <span className="text-xs text-muted-foreground">Not read yet</span>;
      if (r.ok === false)
        return <span className="text-xs text-destructive">Reading failed: {r.detail}</span>;
      if (!r.fileFound) return <span className="text-xs text-muted-foreground">No log file</span>;
      if (!r.top) return <span className="text-xs text-muted-foreground">None</span>;
      return (
        <span className="grid max-w-[32rem] min-w-56 gap-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <LevelBadge level={r.top.level} />
            {sourceText(r.top.source) && (
              <span className="text-xs text-muted-foreground">{sourceText(r.top.source)}</span>
            )}
          </span>
          <span className="line-clamp-2 font-mono text-xs break-words" title={r.top.message}>
            {r.top.message}
          </span>
        </span>
      );
    },
  },
  {
    id: "logging",
    header: "Logging",
    accessorFn: (r) => r.logging.state,
    cell: ({ row }) =>
      row.original.readAt ? (
        <LoggingBadge logging={row.original.logging} />
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  },
  {
    id: "read",
    header: "Read",
    accessorFn: (r) => r.readAt ?? "",
    cell: ({ row }) =>
      row.original.readAt ? (
        <span className="text-xs whitespace-nowrap" title={formatUtc(row.original.readAt)}>
          {timeAgo(row.original.readAt)}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  },
];

export function PhpErrorsTable({ rows }: { rows: ErrorLogRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchLabel="Search sites or messages"
      emptyText="No sites yet."
      initialSorting={[{ id: "fatal", desc: true }]}
    />
  );
}
