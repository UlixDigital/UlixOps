"use client";
import type { PluginSummary } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { DataTable } from "@/components/data-table";
import { formatUtc } from "@/lib/format";
import { cn } from "@/lib/utils";

const count = (value: number, tone: string) =>
  value === 0 ? (
    <span className="text-muted-foreground">0</span>
  ) : (
    <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", tone)}>{value}</span>
  );

const columns: ColumnDef<PluginSummary>[] = [
  {
    id: "name",
    header: "Plugin",
    accessorFn: (p) => `${p.name} ${p.slug}`,
    cell: ({ row }) => (
      <Link href={`/plugins/${row.original.slug}`} className="grid hover:underline">
        <span className="font-medium">{row.original.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{row.original.slug}</span>
      </Link>
    ),
  },
  {
    id: "latest",
    header: "Latest version",
    accessorFn: (p) => p.latestVersion ?? "",
    cell: ({ row }) => (
      <span className="grid">
        <span className="font-mono">{row.original.latestVersion ?? "—"}</span>
        <span className="text-xs text-muted-foreground">{formatUtc(row.original.latestAt)}</span>
      </span>
    ),
  },
  {
    id: "onLatest",
    header: "Sites on latest",
    accessorFn: (p) => p.production.latest,
    cell: ({ getValue }) => count(getValue<number>(), "bg-success/10 text-success"),
  },
  {
    id: "outdated",
    header: "Outdated",
    accessorFn: (p) => p.production.outdated,
    cell: ({ getValue }) => count(getValue<number>(), "bg-warning/10 text-warning"),
  },
  {
    id: "other",
    header: "Not installed / unknown",
    accessorFn: (p) => p.production.notInstalled + p.production.unknown,
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.production.notInstalled} / {row.original.production.unknown}
        {row.original.production.newer > 0 && ` · ${row.original.production.newer} newer`}
      </span>
    ),
  },
];

export function RegistryTable({ plugins }: { plugins: PluginSummary[] }) {
  return (
    <DataTable
      columns={columns}
      data={plugins}
      searchLabel="Search plugins"
      emptyText="No plugins match."
      initialSorting={[{ id: "name", desc: false }]}
    />
  );
}
