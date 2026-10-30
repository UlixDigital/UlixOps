"use client";
import type { AuditEntry } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";
import { cn } from "@/lib/utils";

function resultTone(result: string) {
  if (result === "success") return "bg-success/10 text-success";
  if (result === "alert") return "bg-warning/10 text-warning";
  if (["failure", "denied", "rate_limited"].includes(result))
    return "bg-destructive/10 text-destructive";
  return "bg-muted text-muted-foreground";
}

function details(entry: AuditEntry): string {
  const parts: string[] = [];
  if (entry.siteIds.length > 0) parts.push(`sites: ${entry.siteIds.join(", ")}`);
  if (entry.meta !== null && entry.meta !== undefined) parts.push(JSON.stringify(entry.meta));
  return parts.join(" · ");
}

const columns: ColumnDef<AuditEntry>[] = [
  {
    id: "time",
    header: "Time (UTC)",
    accessorFn: (row) => row.createdAt,
    cell: ({ row }) => (
      <span className="font-mono text-xs whitespace-nowrap">
        {row.original.createdAt.slice(0, 19).replace("T", " ")}
      </span>
    ),
  },
  {
    id: "user",
    header: "User",
    accessorFn: (row) => row.user?.email ?? "system",
    cell: ({ getValue }) => <span className="whitespace-nowrap">{String(getValue())}</span>,
  },
  {
    accessorKey: "action",
    header: "Action",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs whitespace-nowrap">{String(getValue())}</span>
    ),
  },
  {
    accessorKey: "result",
    header: "Result",
    cell: ({ getValue }) => {
      const result = String(getValue());
      return (
        <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", resultTone(result))}>
          {result}
        </span>
      );
    },
  },
  {
    id: "ip",
    header: "IP",
    accessorFn: (row) => row.ip ?? "—",
    cell: ({ getValue }) => (
      <span className="font-mono text-xs whitespace-nowrap">{String(getValue())}</span>
    ),
  },
  {
    id: "details",
    header: "Details",
    enableSorting: false,
    accessorFn: details,
    cell: ({ getValue }) => {
      const text = String(getValue());
      return (
        <span className="block max-w-xs truncate text-xs text-muted-foreground" title={text}>
          {text || "—"}
        </span>
      );
    },
  },
];

export function AuditTable({ entries }: { entries: AuditEntry[] }) {
  return (
    <DataTable
      columns={columns}
      data={entries}
      searchLabel="Search these entries"
      emptyText="No entries match these filters."
      initialSorting={[{ id: "time", desc: true }]}
    />
  );
}
