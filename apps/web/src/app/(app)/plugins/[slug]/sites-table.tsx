"use client";
// The site-by-version matrix (screen 8): which version each site environment runs.
import type { SitePluginRow } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { DataTable } from "@/components/data-table";
import { timeAgo } from "@/lib/format";
import { ENV_LABELS } from "@/lib/site-status";
import { cn } from "@/lib/utils";
import { STATUS } from "./status";

const columns: ColumnDef<SitePluginRow>[] = [
  {
    id: "site",
    header: "Site",
    accessorFn: (r) => r.siteName,
    cell: ({ row }) => (
      <Link
        href={`/sites/${row.original.siteId}/plugins${row.original.kind === "STAGING" ? "?env=staging" : ""}`}
        className="font-medium hover:underline"
      >
        {row.original.siteName}
      </Link>
    ),
  },
  { id: "env", header: "Environment", accessorFn: (r) => ENV_LABELS[r.kind] },
  {
    id: "version",
    header: "Installed version",
    accessorFn: (r) => r.installedVersion ?? "",
    cell: ({ row }) =>
      row.original.installedVersion ? (
        <span className="font-mono">
          {row.original.installedVersion}
          {!row.original.registered && (
            <span className="ml-1.5 font-sans text-xs text-muted-foreground">(not uploaded)</span>
          )}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: "status",
    header: "Status",
    accessorFn: (r) => STATUS[r.status].rank,
    cell: ({ row }) => {
      const s = STATUS[row.original.status];
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", s.tone)}>
            {s.label}
          </span>
          {row.original.active === false && (
            <span className="text-xs text-muted-foreground">inactive</span>
          )}
        </span>
      );
    },
  },
  {
    id: "read",
    header: "Inventory",
    accessorFn: (r) => r.inventoryAt ?? "",
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.inventoryAt ? timeAgo(row.original.inventoryAt) : "—"}
      </span>
    ),
  },
];

export function SitesTable({ rows }: { rows: SitePluginRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchLabel="Search sites"
      emptyText="No sites yet."
      initialSorting={[{ id: "status", desc: false }]}
    />
  );
}
