import { AuditPage, can } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { AuditTable } from "./audit-table";

export const metadata: Metadata = { title: "Audit log · UlixOps" };

const FILTERS = ["action", "email", "result", "from", "to"] as const;
type Filters = Partial<Record<(typeof FILTERS)[number] | "cursor", string>>;

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  if (!can(user.role, "audit.view")) return <NoAccess role={user.role} what="the audit log" />;

  const params = await searchParams;
  const filters: Filters = {};
  for (const key of [...FILTERS, "cursor"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.trim() !== "") filters[key] = value.trim();
  }
  const { cursor: _cursor, ...activeFilters } = filters;
  const res = await apiGet(`/audit?${new URLSearchParams(filters)}`, AuditPage, await apiAuth());
  if (!res.ok && res.error === "session_expired_idle") redirect("/login?reason=idle");
  if (!res.ok && res.error === "session_expired_absolute") redirect("/login?reason=expired");
  if (!res.ok && res.error === "session_invalid") redirect("/login");
  if (!res.ok && res.error === "forbidden")
    return <NoAccess role={user.role} what="the audit log" />;

  const older =
    res.ok && res.data.nextCursor ? { ...activeFilters, cursor: res.data.nextCursor } : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
          <p className="text-sm text-muted-foreground">
            Every action in UlixOps, newest first. Entries can't be changed or deleted, not even by
            the app itself.
          </p>
        </div>
        <a
          href={`/audit/export?${new URLSearchParams(activeFilters)}`}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent"
          download
        >
          Export CSV
        </a>
      </div>

      <form
        method="get"
        className="grid items-end gap-3 rounded-lg border p-4 sm:grid-cols-3 lg:grid-cols-6"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="action">Action starts with</Label>
          <Input id="action" name="action" placeholder="auth." defaultValue={filters.action} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="email">User email</Label>
          <Input id="email" name="email" type="email" defaultValue={filters.email} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="result">Result</Label>
          <Input id="result" name="result" placeholder="failure" defaultValue={filters.result} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="from">From (UTC)</Label>
          <Input id="from" name="from" type="date" defaultValue={filters.from} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">To (UTC)</Label>
          <Input id="to" name="to" type="date" defaultValue={filters.to} />
        </div>
        <div className="flex gap-2">
          <Button type="submit">Filter</Button>
          <Link
            href="/audit"
            className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground hover:text-foreground"
          >
            Clear
          </Link>
        </div>
      </form>

      {!res.ok ? (
        <Notice tone="error">Those filters aren't valid. Check the dates and try again.</Notice>
      ) : (
        <AuditTable entries={res.data.entries} />
      )}

      {older && (
        <Link
          href={`/audit?${new URLSearchParams(older)}`}
          className="justify-self-end text-sm text-link hover:underline"
        >
          Older entries →
        </Link>
      )}
    </div>
  );
}
