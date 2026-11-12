"use client";
// Every environment's SSL certificate (A148): soonest expiry and problems first.
import type { CertificateView } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import { EnvBadge } from "@/components/env-badge";
import { dateOnly, ExpiryBadge } from "@/components/expiry-badge";
import { formatUtc, timeAgo } from "@/lib/format";

/** Problems first, then by days left; plain http last. */
function rank(c: CertificateView): number {
  if (!c.https) return 100_000;
  if (!c.ok && (c.daysLeft === null || c.daysLeft >= 0)) return -100_000;
  return c.daysLeft ?? 50_000;
}

export function CertificatesTable({ rows }: { rows: CertificateView[] }) {
  const columns = useMemo<ColumnDef<CertificateView>[]>(
    () => [
      {
        id: "site",
        header: "Site",
        accessorFn: (r) => `${r.siteName} ${r.host}`,
        cell: ({ row }) => (
          <span className="grid gap-0.5">
            <span className="flex flex-wrap items-center gap-1.5">
              <Link
                href={`/sites/${row.original.siteId}/monitoring`}
                className="font-medium hover:underline"
              >
                {row.original.siteName}
              </Link>
              {row.original.environment === "STAGING" && <EnvBadge kind="STAGING" />}
            </span>
            <span className="text-xs break-all text-muted-foreground">{row.original.host}</span>
          </span>
        ),
      },
      {
        id: "status",
        header: "Certificate",
        accessorFn: rank,
        cell: ({ row }) => {
          const c = row.original;
          if (!c.https) return <ExpiryBadge days={null} label="Plain http" />;
          return (
            <span className="grid gap-1">
              <ExpiryBadge days={c.daysLeft} problem={!c.ok} />
              {c.error && <span className="max-w-72 text-xs text-destructive">{c.error}</span>}
            </span>
          );
        },
      },
      {
        id: "expires",
        header: "Expires",
        accessorFn: (r) => r.validTo ?? "",
        cell: ({ row }) => (
          <span className="text-sm whitespace-nowrap tabular-nums">
            {dateOnly(row.original.validTo)}
          </span>
        ),
      },
      {
        id: "issuer",
        header: "Issuer",
        accessorFn: (r) => r.issuer ?? "",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{row.original.issuer ?? "—"}</span>
        ),
      },
      {
        id: "checked",
        header: "Checked",
        accessorFn: (r) => r.checkedAt,
        cell: ({ row }) => (
          <span
            className="text-xs whitespace-nowrap text-muted-foreground"
            title={formatUtc(row.original.checkedAt)}
          >
            {timeAgo(row.original.checkedAt)}
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
      searchLabel="Search certificates"
      emptyText="No certificates checked yet."
      initialSorting={[{ id: "status", desc: false }]}
    />
  );
}
