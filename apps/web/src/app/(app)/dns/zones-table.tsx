"use client";
// Every Cloudflare domain the token can see (A156): status, linked site, records, changes.
import type { DnsZoneView } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { DataTable } from "@/components/data-table";
import { formatUtc, timeAgo } from "@/lib/format";
import { zoneStatusBadge } from "./zone-status";

const columns: ColumnDef<DnsZoneView>[] = [
  {
    id: "name",
    header: "Domain",
    accessorFn: (z) => `${z.name} ${z.site?.name ?? ""} ${z.accountName ?? ""}`,
    cell: ({ row }) => (
      <span className="grid gap-0.5">
        <Link href={`/dns/${row.original.id}`} className="font-medium hover:underline">
          {row.original.name}
        </Link>
        <span className="text-xs text-muted-foreground">
          {row.original.accountName ?? "Cloudflare"}
          {row.original.plan ? ` · ${row.original.plan}` : ""}
        </span>
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    accessorFn: (z) => (z.removed ? 3 : z.status === "active" && !z.paused ? 0 : 1),
    cell: ({ row }) => zoneStatusBadge(row.original),
  },
  {
    id: "site",
    header: "Site",
    accessorFn: (z) => z.site?.name ?? "~",
    cell: ({ row }) =>
      row.original.site ? (
        <Link href={`/sites/${row.original.site.id}`} className="hover:underline">
          {row.original.site.name}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { id: "records", header: "Records", accessorFn: (z) => z.recordCount },
  {
    id: "changes",
    header: "Outside changes (7 days)",
    accessorFn: (z) => z.externalChanges7d,
    cell: ({ getValue }) => {
      const n = getValue<number>();
      return n === 0 ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
          {n}
        </span>
      );
    },
  },
  {
    id: "synced",
    header: "Last read",
    accessorFn: (z) => z.lastSyncAt ?? "",
    cell: ({ row }) =>
      row.original.lastSyncAt ? (
        <span className="text-xs whitespace-nowrap" title={formatUtc(row.original.lastSyncAt)}>
          {timeAgo(row.original.lastSyncAt)}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">Not yet</span>
      ),
  },
];

export function ZonesTable({ zones }: { zones: DnsZoneView[] }) {
  return (
    <DataTable
      columns={columns}
      data={zones}
      searchLabel="Search domains"
      emptyText="No domains yet. Refresh from Cloudflare once the token is set."
      initialSorting={[{ id: "changes", desc: true }]}
    />
  );
}
