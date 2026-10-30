"use client";
import type { SiteView } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { DataTable } from "@/components/data-table";
import { HOST_LABELS, siteHealthStatus, siteStatus } from "@/lib/site-status";
import { cn } from "@/lib/utils";

const production = (site: SiteView) => site.environments.find((e) => e.kind === "PRODUCTION");

const columns: ColumnDef<SiteView>[] = [
  {
    id: "name",
    header: "Name",
    accessorFn: (s) => s.name,
    cell: ({ row }) => (
      <Link href={`/sites/${row.original.id}`} className="font-medium hover:underline">
        {row.original.name}
        {row.original.archived && (
          <span className="ml-2 text-xs font-normal text-muted-foreground">(archived)</span>
        )}
      </Link>
    ),
  },
  {
    id: "url",
    header: "URL",
    accessorFn: (s) => s.url,
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.url.replace(/^https?:\/\//, "")}</span>
    ),
  },
  { id: "host", header: "Host", accessorFn: (s) => HOST_LABELS[s.host] },
  {
    id: "tags",
    header: "Client / tags",
    accessorFn: (s) => s.tags.join(" "),
    cell: ({ row }) => (
      <span className="flex flex-wrap gap-1">
        {row.original.tags.map((tag) => (
          <span key={tag} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
            {tag}
          </span>
        ))}
      </span>
    ),
  },
  { id: "wp", header: "WordPress", accessorFn: (s) => production(s)?.wpVersion ?? "—" },
  { id: "php", header: "PHP", accessorFn: (s) => production(s)?.phpVersion ?? "—" },
  {
    id: "updates",
    header: "Updates",
    // Sorts sites with updates first; sites never read sort last.
    accessorFn: (s) => {
      const inv = production(s)?.inventory;
      return inv ? inv.pluginUpdates + inv.themeUpdates : -1;
    },
    cell: ({ getValue }) => {
      const count = getValue<number>();
      if (count < 0) return <span className="text-muted-foreground">—</span>;
      if (count === 0) return <span className="text-muted-foreground">None</span>;
      return (
        <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
          {count} available
        </span>
      );
    },
  },
  {
    id: "status",
    header: "Connection",
    accessorFn: (s) => siteStatus(s).rank,
    cell: ({ row }) => {
      const status = siteStatus(row.original);
      return (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", status.tone)}>
            {status.label}
          </span>
          {row.original.pendingApprovals > 0 && (
            <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
              Approval pending
            </span>
          )}
        </span>
      );
    },
  },
  {
    id: "health",
    header: "Health",
    accessorFn: (s) => siteHealthStatus(s).rank,
    cell: ({ row }) => {
      const status = siteHealthStatus(row.original);
      return (
        <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", status.tone)}>
          {status.label}
        </span>
      );
    },
  },
];

export function SitesTable({ sites }: { sites: SiteView[] }) {
  return (
    <DataTable
      columns={columns}
      data={sites}
      searchLabel="Search sites"
      emptyText="No sites match."
      initialSorting={[{ id: "name", desc: false }]}
    />
  );
}
