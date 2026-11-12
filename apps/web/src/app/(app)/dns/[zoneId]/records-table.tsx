"use client";
// A domain's records (A156). A, AAAA, CNAME, TXT and MX can be edited and deleted here; other
// types are shown for reference and changed in Cloudflare.
import { type DnsRecord, MANAGED_RECORD_TYPES, shortRecordName } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import { ActionForm } from "@/components/action-form";
import { DataTable } from "@/components/data-table";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deleteRecordAction } from "../actions";

const managed = (type: string) => (MANAGED_RECORD_TYPES as readonly string[]).includes(type);

export function RecordsTable({
  zoneId,
  zone,
  records,
  canManage,
}: {
  zoneId: string;
  zone: string;
  records: DnsRecord[];
  canManage: boolean;
}) {
  const columns = useMemo<ColumnDef<DnsRecord>[]>(
    () => [
      {
        id: "type",
        header: "Type",
        accessorFn: (r) => r.type,
        cell: ({ row }) => (
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
            {row.original.type}
          </span>
        ),
      },
      {
        id: "name",
        header: "Name",
        accessorFn: (r) => r.name,
        cell: ({ row }) => (
          <span className="block max-w-48 font-mono text-xs break-all" title={row.original.name}>
            {shortRecordName(row.original.name, zone)}
          </span>
        ),
      },
      {
        id: "content",
        header: "Content",
        accessorFn: (r) => `${r.content} ${r.comment ?? ""}`,
        cell: ({ row }) => (
          <span className="grid max-w-[28rem] min-w-48 gap-0.5">
            <span className="font-mono text-xs break-all">
              {row.original.priority !== null && row.original.type === "MX"
                ? `${row.original.priority} `
                : ""}
              {row.original.content}
            </span>
            {row.original.comment && (
              <span className="text-xs break-words text-muted-foreground">
                {row.original.comment}
              </span>
            )}
          </span>
        ),
      },
      {
        id: "proxy",
        header: "Proxy",
        accessorFn: (r) => (r.proxied ? 1 : 0),
        cell: ({ row }) => (
          <span
            className={cn(
              "rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
              row.original.proxied
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
            )}
          >
            {row.original.proxied ? "Proxied" : "DNS only"}
          </span>
        ),
      },
      {
        id: "ttl",
        header: "TTL",
        accessorFn: (r) => r.ttl,
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap">
            {row.original.ttl === 1 ? "Auto" : `${row.original.ttl} s`}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          if (!canManage) return null;
          if (!managed(r.type))
            return (
              <span className="text-xs whitespace-nowrap text-muted-foreground">
                Edit in Cloudflare
              </span>
            );
          return (
            <div className="flex items-start justify-end gap-2 whitespace-nowrap">
              <Link
                href={`/dns/${zoneId}?edit=${r.id}#edit-record`}
                className={buttonVariants({ variant: "outline" })}
              >
                Edit
              </Link>
              <ActionForm
                action={deleteRecordAction}
                submitLabel="Delete"
                variant="destructive"
                pendingLabel="Deleting…"
                confirm={{
                  title: `Delete ${r.type} ${r.name}?`,
                  description:
                    "It stops resolving at once (mail or the website can break). A snapshot of the domain is taken first, so it can be rolled back.",
                }}
              >
                <input type="hidden" name="zoneId" value={zoneId} />
                <input type="hidden" name="recordId" value={r.id} />
              </ActionForm>
            </div>
          );
        },
      },
    ],
    [zoneId, zone, canManage],
  );
  return (
    <DataTable
      columns={columns}
      data={records}
      searchLabel="Search records"
      emptyText="No records read yet. Refresh from Cloudflare."
      initialSorting={[{ id: "type", desc: false }]}
    />
  );
}
