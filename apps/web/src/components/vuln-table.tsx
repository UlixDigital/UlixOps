"use client";
// Vulnerability findings (Phase 2 step 2): the Security page and a site's Security tab.
import { SEVERITY_ORDER, type VulnFindingView } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { DataTable } from "@/components/data-table";
import { EnvBadge } from "@/components/env-badge";
import { formatUtc, timeAgo } from "@/lib/format";
import { SEVERITY } from "@/lib/site-status";
import { cn } from "@/lib/utils";

const TYPE_LABELS = { core: "WordPress core", plugin: "Plugin", theme: "Theme" } as const;

function columns(showSite: boolean): ColumnDef<VulnFindingView>[] {
  const cols: ColumnDef<VulnFindingView>[] = [
    {
      id: "severity",
      header: "Severity",
      // Worst first when sorted ascending.
      accessorFn: (f) => SEVERITY_ORDER.indexOf(f.severity),
      cell: ({ row }) => {
        const s = SEVERITY[row.original.severity];
        return (
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", s.tone)}>
              {s.label}
            </span>
            {row.original.cvssScore !== null && (
              <span className="text-xs text-muted-foreground">
                {row.original.cvssScore.toFixed(1)}
              </span>
            )}
          </span>
        );
      },
    },
  ];
  if (showSite)
    cols.push({
      id: "site",
      header: "Site",
      accessorFn: (f) => f.siteName,
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
    });
  else
    cols.push({
      id: "environment",
      header: "Environment",
      accessorFn: (f) => f.environment,
      cell: ({ row }) => <EnvBadge kind={row.original.environment} />,
    });
  cols.push(
    {
      id: "software",
      header: "Software",
      accessorFn: (f) => `${f.slug} ${TYPE_LABELS[f.type]}`,
      cell: ({ row }) => (
        <span className="grid">
          <span className="font-mono text-xs">{row.original.slug}</span>
          <span className="text-xs text-muted-foreground">{TYPE_LABELS[row.original.type]}</span>
        </span>
      ),
    },
    {
      id: "version",
      header: "Installed → fixed in",
      accessorFn: (f) => f.installedVersion,
      cell: ({ row }) => (
        <span className="font-mono text-xs whitespace-nowrap">
          {row.original.installedVersion} →{" "}
          {row.original.fixedIn ?? <span className="font-sans text-warning">no fix yet</span>}
        </span>
      ),
    },
    {
      id: "title",
      header: "Vulnerability",
      accessorFn: (f) => `${f.title} ${f.cve ?? ""}`,
      cell: ({ row }) => (
        <span className="grid gap-0.5">
          {row.original.reference ? (
            <a
              href={row.original.reference}
              target="_blank"
              rel="noopener noreferrer"
              className="text-link hover:underline"
            >
              {row.original.title}
            </a>
          ) : (
            row.original.title
          )}
          {row.original.cve && (
            <span className="font-mono text-xs text-muted-foreground">{row.original.cve}</span>
          )}
        </span>
      ),
    },
    {
      id: "seen",
      header: "First seen",
      accessorFn: (f) => f.firstSeenAt,
      cell: ({ row }) => (
        <span
          className="text-xs whitespace-nowrap text-muted-foreground"
          title={formatUtc(row.original.firstSeenAt)}
        >
          {timeAgo(row.original.firstSeenAt)}
          {row.original.resolvedAt && (
            <span className="block text-success">Resolved {timeAgo(row.original.resolvedAt)}</span>
          )}
        </span>
      ),
    },
  );
  return cols;
}

export function VulnTable({
  findings,
  showSite = true,
  emptyText,
}: {
  findings: VulnFindingView[];
  showSite?: boolean;
  emptyText: string;
}) {
  return (
    <DataTable
      columns={columns(showSite)}
      data={findings}
      searchLabel="Search vulnerabilities"
      emptyText={emptyText}
      initialSorting={[{ id: "severity", desc: false }]}
    />
  );
}
