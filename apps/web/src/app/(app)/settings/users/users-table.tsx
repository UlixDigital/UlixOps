"use client";
import type { UserSummary } from "@ulixops/shared";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { DataTable } from "@/components/data-table";
import { ROLE_LABELS, timeAgo } from "@/lib/format";
import { statusOf } from "@/lib/user-status";
import { cn } from "@/lib/utils";

const columns: ColumnDef<UserSummary>[] = [
  {
    id: "person",
    header: "Person",
    accessorFn: (u) => `${u.name ?? ""} ${u.email}`,
    cell: ({ row }) => (
      <Link href={`/settings/users/${row.original.id}`} className="group grid">
        <span className="font-medium group-hover:underline">
          {row.original.name ?? row.original.email}
        </span>
        {row.original.name && (
          <span className="text-xs text-muted-foreground">{row.original.email}</span>
        )}
      </Link>
    ),
  },
  {
    id: "role",
    header: "Role",
    accessorFn: (u) =>
      u.viewTag ? `${ROLE_LABELS[u.role]} (${u.viewTag})` : ROLE_LABELS[u.role],
  },
  {
    id: "status",
    header: "Status",
    accessorFn: (u) => statusOf(u).label,
    cell: ({ row }) => {
      const status = statusOf(row.original);
      return (
        <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", status.tone)}>
          {status.label}
        </span>
      );
    },
  },
  {
    id: "lastLogin",
    header: "Last sign-in",
    accessorFn: (u) => u.lastLoginAt ?? "",
    cell: ({ row }) => (
      <span className="text-muted-foreground">{timeAgo(row.original.lastLoginAt)}</span>
    ),
  },
  { accessorKey: "activeSessions", header: "Sessions" },
  {
    id: "manage",
    header: "",
    enableSorting: false,
    cell: ({ row }) => (
      <Link
        href={`/settings/users/${row.original.id}`}
        className="text-sm text-link hover:underline"
      >
        Manage
      </Link>
    ),
  },
];

export function UsersTable({ users }: { users: UserSummary[] }) {
  return (
    <DataTable
      columns={columns}
      data={users}
      searchLabel="Search people"
      emptyText="No people yet."
    />
  );
}
