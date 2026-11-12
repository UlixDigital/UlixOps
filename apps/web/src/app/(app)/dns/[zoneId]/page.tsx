// One Cloudflare domain (spec screen 15, A156): records with add / edit / delete, change
// history, snapshots with rollback (approval), cache purge and the migration checklist.
import { can, CfId, DnsZoneDetail, MANAGED_RECORD_TYPES } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { checklistAction, purgeAction, requestRollbackAction, syncZoneAction } from "../actions";
import { zoneStatusBadge } from "../zone-status";
import { RecordForm } from "./record-form";
import { RecordsTable } from "./records-table";

export const metadata: Metadata = { title: "DNS domain · UlixOps" };

const REASONS: Record<string, string> = {
  first: "First read",
  sync: "Changed outside UlixOps",
  "before-change": "Before a change",
  "after-change": "After a change",
  "before-rollback": "Before a rollback",
  "after-rollback": "After a rollback",
};

export default async function ZonePage({
  params,
  searchParams,
}: {
  params: Promise<{ zoneId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const zoneId = CfId.safeParse((await params).zoneId);
  const editId = (await searchParams).edit;
  if (!zoneId.success) notFound();
  const res = await apiGet(`/dns/zones/${zoneId.data}`, DnsZoneDetail, await apiAuth(), {
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    if (res.error === "not_found") notFound();
    return <Notice tone="error">This domain couldn&apos;t be loaded. Refresh the page.</Notice>;
  }
  const { zone, records, changes, snapshots, checklist, pendingRollback } = res.data;
  const canManage = can(user.role, "dns.manage") && !zone.removed;
  const canRefresh = can(user.role, "sites.refresh") && !zone.removed;
  const canPurge = can(user.role, "site.emergency") && !zone.removed;
  const zoneField = <input type="hidden" name="zoneId" value={zone.id} />;
  // ?edit=<record id> opens the edit panel above the table (A156).
  const editing =
    canManage && typeof editId === "string"
      ? records.find(
          (r) => r.id === editId && (MANAGED_RECORD_TYPES as readonly string[]).includes(r.type),
        )
      : undefined;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <Link href="/dns" className="text-xs text-muted-foreground hover:underline">
            ← DNS
          </Link>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight break-all">
            {zone.name} {zoneStatusBadge(zone)}
          </h1>
          <p className="text-sm text-muted-foreground">
            {zone.accountName ?? "Cloudflare"}
            {zone.plan ? ` · ${zone.plan}` : ""}
            {zone.site && (
              <>
                {" · site "}
                <Link href={`/sites/${zone.site.id}`} className="text-link hover:underline">
                  {zone.site.name}
                </Link>
              </>
            )}
            {" · read "}
            <span title={formatUtc(zone.lastSyncAt)}>
              {zone.lastSyncAt ? timeAgo(zone.lastSyncAt) : "never"}
            </span>
          </p>
        </div>
        {canRefresh && (
          <ActionForm
            action={syncZoneAction}
            submitLabel="Refresh from Cloudflare"
            variant="outline"
            pendingLabel="Reading…"
          >
            {zoneField}
          </ActionForm>
        )}
      </div>
      {zone.removed && (
        <Notice tone="error">
          The Cloudflare token can no longer see this domain, so it can&apos;t be changed here. Its
          history and snapshots are kept.
        </Notice>
      )}
      {zone.externalChanges7d > 0 && (
        <Notice>
          This domain was changed outside UlixOps {zone.externalChanges7d} time
          {zone.externalChanges7d === 1 ? "" : "s"} in the last 7 days (see Changes). If nobody on
          the team did that, roll back to an earlier snapshot.
        </Notice>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Records ({records.length})</CardTitle>
          <CardDescription>
            As last read from Cloudflare. Changes go live at once; a snapshot is taken before and
            after each one.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {editing && (
            <section
              id="edit-record"
              aria-label="Edit record"
              className="grid gap-3 rounded-md border border-primary/40 bg-primary/5 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold break-all">
                  Edit {editing.type} {editing.name}
                </h2>
                <Link
                  href={`/dns/${zone.id}`}
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  Cancel
                </Link>
              </div>
              <div className="max-w-2xl">
                <RecordForm zoneId={zone.id} zone={zone.name} record={editing} />
              </div>
            </section>
          )}
          <RecordsTable zoneId={zone.id} zone={zone.name} records={records} canManage={canManage} />
          {canManage && (
            <details className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer font-medium">Add a record</summary>
              <div className="mt-3 max-w-2xl">
                <RecordForm zoneId={zone.id} zone={zone.name} />
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Snapshots</CardTitle>
            <CardDescription>
              The whole record set at that moment (last 90 days, at least 20 kept). Rolling back
              restores A, AAAA, CNAME, TXT and MX records; another Admin approves first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {pendingRollback && (
              <Notice>
                A rollback is waiting for approval or running.{" "}
                <Link href="/approvals" className="text-link hover:underline">
                  Approvals
                </Link>
              </Notice>
            )}
            {snapshots.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No snapshots yet. Refresh from Cloudflare.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {snapshots.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2 text-sm"
                  >
                    <span className="grid gap-0.5">
                      <span title={formatUtc(s.takenAt)}>{formatUtc(s.takenAt)}</span>
                      <span className="text-xs text-muted-foreground">
                        {REASONS[s.reason] ?? s.reason} · {s.recordCount} records ·{" "}
                        {s.differences === 0
                          ? "same as now"
                          : `${s.differences} difference${s.differences === 1 ? "" : "s"} from now`}
                      </span>
                    </span>
                    {canManage && s.differences > 0 && !pendingRollback && (
                      <ActionForm
                        action={requestRollbackAction}
                        submitLabel="Roll back to this"
                        variant="destructive"
                        confirm={{
                          title: `Roll ${zone.name} back to ${formatUtc(s.takenAt)}?`,
                          description: `${s.differences} record change${s.differences === 1 ? "" : "s"} will be made in Cloudflare to match this snapshot. Another Admin approves first; a snapshot of the domain as it is now is taken before anything changes.`,
                        }}
                      >
                        {zoneField}
                        <input type="hidden" name="snapshotId" value={s.id} />
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Changes</CardTitle>
            <CardDescription>
              Newest first: changes made here, rollbacks, purges and changes made outside UlixOps.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {changes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No changes yet.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {changes.map((c) => (
                  <li key={c.id} className="grid gap-1 px-3 py-2 text-sm">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span
                        className={cn(
                          "min-w-0 font-medium break-words",
                          !c.ok && "text-destructive",
                        )}
                      >
                        {c.summary}
                      </span>
                      {c.kind === "external" && (
                        <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
                          Outside UlixOps
                        </span>
                      )}
                    </span>
                    {c.lines.length > 0 && (
                      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap">
                        {c.lines.join("\n")}
                      </pre>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {c.by ?? (c.kind === "external" ? "Seen by UlixOps" : "UlixOps")} ·{" "}
                      <span title={formatUtc(c.at)}>{timeAgo(c.at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Migration checklist</CardTitle>
            <CardDescription>
              For moving this domain onto Cloudflare. Steps marked automatic are read from
              Cloudflare.
              {zone.originalNameServers.length > 0 &&
                ` Previous nameservers: ${zone.originalNameServers.join(", ")}.`}
              {zone.nameServers.length > 0 &&
                ` Cloudflare nameservers: ${zone.nameServers.join(", ")}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {checklist.map((step) => (
                <li
                  key={step.key}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm sm:flex-nowrap"
                >
                  <span className="flex min-w-0 flex-1 items-start gap-2">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-sm border text-[10px]",
                        step.done ? "border-success bg-success/10 text-success" : "border-input",
                      )}
                    >
                      {step.done ? "✓" : ""}
                    </span>
                    <span>
                      {step.label}
                      {step.auto && (
                        <span className="ml-1 text-xs text-muted-foreground">(automatic)</span>
                      )}
                      <span className="sr-only">{step.done ? " — done" : " — not done"}</span>
                    </span>
                  </span>
                  {canManage && !step.auto && (
                    <ActionForm
                      action={checklistAction}
                      submitLabel={step.done ? "Undo" : "Mark done"}
                      variant="outline"
                    >
                      {zoneField}
                      <input type="hidden" name="key" value={step.key} />
                      <input type="hidden" name="done" value={step.done ? "false" : "true"} />
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {canPurge && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cloudflare cache</CardTitle>
              <CardDescription>
                Clear Cloudflare&apos;s copy of pages and files so visitors get the latest version.
                This doesn&apos;t touch the site or WP Engine&apos;s own cache.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <ActionForm action={purgeAction} submitLabel="Purge specific URLs" variant="outline">
                {zoneField}
                <input type="hidden" name="everything" value="false" />
                <div className="grid gap-1.5">
                  <Label htmlFor="purge-urls">URLs, one per line (up to 30)</Label>
                  <textarea
                    id="purge-urls"
                    name="urls"
                    rows={3}
                    placeholder={`https://${zone.name}/`}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                  />
                </div>
              </ActionForm>
              <ActionForm
                action={purgeAction}
                submitLabel="Purge everything"
                variant="destructive"
                confirm={{
                  title: `Purge all of Cloudflare's cache for ${zone.name}?`,
                  description:
                    "Every page and file is fetched from the server again, so the site may be slower for a few minutes.",
                }}
              >
                {zoneField}
                <input type="hidden" name="everything" value="true" />
              </ActionForm>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
