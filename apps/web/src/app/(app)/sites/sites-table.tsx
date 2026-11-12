"use client";
import type { SiteView } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { DataTable } from "@/components/data-table";
import {
  HOST_LABELS,
  phpStatus,
  siteHealthStatus,
  siteStatus,
  siteUptimeStatus,
  siteVulnStatus,
} from "@/lib/site-status";
import { percentText } from "@/components/uptime-badge";
import { cn } from "@/lib/utils";

const production = (site: SiteView) => site.environments.find((e) => e.kind === "PRODUCTION");

const columns: ColumnDef<SiteView>[] = [
  {
    id: "name",
    header: "Name",
    // The URL sits under the name (no column of its own) and is searchable too.
    accessorFn: (s) => `${s.name} ${s.url}`,
    cell: ({ row }) => (
      <span className="grid gap-0.5">
        <Link href={`/sites/${row.original.id}`} className="font-medium hover:underline">
          {row.original.name}
          {row.original.archived && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">(archived)</span>
          )}
        </Link>
        <span className="max-w-64 truncate text-xs text-muted-foreground" title={row.original.url}>
          {row.original.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
        </span>
      </span>
    ),
  },
  {
    id: "tags",
    header: "Host / tags",
    accessorFn: (s) => [HOST_LABELS[s.host], ...s.tags].join(" "),
    cell: ({ row }) => (
      <span className="flex flex-wrap gap-1">
        <span className="rounded-md border px-1.5 py-0.5 text-xs whitespace-nowrap">
          {HOST_LABELS[row.original.host]}
        </span>
        {row.original.tags.map((tag) => (
          <span key={tag} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
            {tag}
          </span>
        ))}
      </span>
    ),
  },
  { id: "wp", header: "WordPress", accessorFn: (s) => production(s)?.wpVersion ?? "—" },
  {
    id: "php",
    header: "PHP",
    // Sorts by support status (end of life first when descending), then version.
    accessorFn: (s) => phpStatus(production(s)?.phpVersion).rank,
    cell: ({ row }) => {
      const version = production(row.original)?.phpVersion;
      if (!version) return <span className="text-muted-foreground">—</span>;
      const status = phpStatus(version);
      return (
        <span className="flex flex-wrap items-center gap-1.5" title={status.title}>
          {version}
          {status.rank >= 2 && (
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
                status.tone,
              )}
            >
              {status.label}
            </span>
          )}
        </span>
      );
    },
  },
  {
    id: "updates",
    header: "Updates",
    // Sorts sites with updates first; sites never read sort last.
    accessorFn: (s) => {
      const inv = production(s)?.inventory;
      return inv ? inv.pluginUpdates + inv.themeUpdates + (inv.coreUpdateVersion ? 1 : 0) : -1;
    },
    cell: ({ getValue }) => {
      const count = getValue<number>();
      if (count < 0) return <span className="text-muted-foreground">—</span>;
      if (count === 0) return <span className="text-muted-foreground">None</span>;
      return (
        <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-warning">
          {count} available
        </span>
      );
    },
  },
  {
    id: "vulns",
    header: "Vulnerabilities",
    // Worst severity first when sorted descending, then the most findings.
    accessorFn: (s) => siteVulnStatus(s).rank,
    cell: ({ row }) => {
      const status = siteVulnStatus(row.original);
      if (status.rank < 0) return <span className="text-muted-foreground">—</span>;
      if (status.open === 0) return <span className="text-muted-foreground">None</span>;
      return (
        <Link
          href={`/sites/${row.original.id}/security`}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap hover:underline",
            status.tone,
          )}
        >
          {status.label}
        </Link>
      );
    },
  },
  {
    id: "uptime",
    header: "Uptime",
    // Down first when sorted descending, then sites under 99% over 24 hours.
    accessorFn: (s) => siteUptimeStatus(s).rank,
    cell: ({ row }) => {
      const status = siteUptimeStatus(row.original);
      if (status.rank === -2) return <span className="text-muted-foreground">—</span>;
      return (
        <Link
          href={`/sites/${row.original.id}/monitoring`}
          className="flex flex-wrap items-center gap-1.5 whitespace-nowrap hover:underline"
          title="Uptime over the last 24 hours"
        >
          <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", status.tone)}>
            {status.label}
          </span>
          {status.percent !== null && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {percentText(status.percent)}
            </span>
          )}
        </Link>
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
