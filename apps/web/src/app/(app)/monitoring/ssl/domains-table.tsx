"use client";
// Registered domains and when they expire (A148). Admins can enter the date for domains whose
// registry publishes none.
import type { DomainView } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import { DomainExpiryForm } from "@/components/domain-expiry-form";
import { dateOnly, ExpiryBadge } from "@/components/expiry-badge";
import { formatUtc, timeAgo } from "@/lib/format";

export function DomainsTable({ rows, canManage }: { rows: DomainView[]; canManage: boolean }) {
  const columns = useMemo<ColumnDef<DomainView>[]>(
    () => [
      {
        id: "domain",
        header: "Domain",
        accessorFn: (r) => `${r.domain} ${r.sites.map((s) => s.name).join(" ")}`,
        cell: ({ row }) => (
          <span className="grid gap-0.5">
            <span className="font-medium break-all">{row.original.domain}</span>
            <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              {row.original.sites.map((s) => (
                <Link key={s.id} href={`/sites/${s.id}/monitoring`} className="hover:underline">
                  {s.name}
                </Link>
              ))}
            </span>
          </span>
        ),
      },
      {
        id: "status",
        header: "Registration",
        accessorFn: (r) => r.daysLeft ?? 100_000,
        cell: ({ row }) => {
          const d = row.original;
          return (
            <span className="grid gap-1">
              <ExpiryBadge
                days={d.daysLeft}
                label={d.daysLeft === null ? "No expiry date" : undefined}
              />
              {d.manual && <span className="text-xs text-muted-foreground">Entered by hand</span>}
              {d.error && (
                <span
                  className={
                    d.status === "error"
                      ? "max-w-72 text-xs text-warning"
                      : "max-w-72 text-xs text-muted-foreground"
                  }
                >
                  {d.error}
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: "expires",
        header: "Expires",
        accessorFn: (r) => r.expiresAt ?? "",
        cell: ({ row }) => (
          <span className="text-sm whitespace-nowrap tabular-nums">
            {dateOnly(row.original.expiresAt)}
          </span>
        ),
      },
      {
        id: "registrar",
        header: "Registrar",
        accessorFn: (r) => r.registrar ?? "",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{row.original.registrar ?? "—"}</span>
        ),
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
            {timeAgo(row.original.checkedAt)}
          </span>
        ),
      },
      ...(canManage
        ? [
            {
              id: "manual",
              header: () => <span className="sr-only">Expiry date by hand</span>,
              enableSorting: false,
              cell: ({ row }: { row: { original: DomainView } }) =>
                row.original.status !== "found" || row.original.manual ? (
                  <DomainExpiryForm domain={row.original} />
                ) : null,
            } satisfies ColumnDef<DomainView>,
          ]
        : []),
    ],
    [canManage],
  );
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchLabel="Search domains"
      emptyText="No domains checked yet."
      initialSorting={[{ id: "status", desc: false }]}
    />
  );
}
