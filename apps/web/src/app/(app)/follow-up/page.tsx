// Alert follow-up (A158, Super Admin only): who saw each alert, who took and fixed it, and
// whether the fix held according to the next check or a Super Admin.
import { ALERT_STATUS_LABELS, AlertTrackingReport, type AlertRow, can } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { AlertStatusBadge, formatDuration, SEVERITY_BADGE } from "@/components/alert-status";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { ROLE_LABELS, formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DailyChart, FunnelChart, Meter } from "./charts";

export const metadata: Metadata = { title: "Alert follow-up · UlixOps" };

const PERIODS = [7, 30, 90] as const;

function AlertTable({
  rows,
  empty,
  closed,
}: {
  rows: AlertRow[];
  empty: string;
  closed?: boolean;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Alert</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">{closed ? "Fixed by" : "Owner"}</th>
            <th className="py-2 pr-3 font-medium">Seen by</th>
            <th className="py-2 font-medium">{closed ? "Closed" : "Open for"}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="max-w-[22rem] py-2 pr-3">
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-0.5 rounded px-1 text-[10px] font-semibold uppercase",
                      SEVERITY_BADGE[r.severity],
                    )}
                  >
                    {r.severity}
                  </span>
                  <div className="min-w-0">
                    <Link href={`/follow-up/${r.id}`} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {[
                        r.siteNames.join(", "),
                        r.occurrences > 1 ? `reported ${r.occurrences}×` : null,
                        r.reopenCount > 0
                          ? `${r.reopenCount} fix${r.reopenCount === 1 ? "" : "es"} didn't hold`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </div>
              </td>
              <td className="py-2 pr-3">
                <AlertStatusBadge status={r.status} />
              </td>
              <td className="py-2 pr-3 text-xs">
                {closed
                  ? (r.resolvedByName ?? (r.status === "AUTO_CLEARED" ? "Nobody (cleared)" : "—"))
                  : (r.ownerName ?? <span className="text-warning">Nobody yet</span>)}
              </td>
              <td className="py-2 pr-3 text-xs tabular-nums">
                <span className={cn(r.seenBy === 0 && "font-medium text-destructive")}>
                  {r.seenBy} of {r.recipients}
                </span>
              </td>
              <td
                className="py-2 text-xs whitespace-nowrap"
                title={formatUtc(closed ? r.closedAt : r.firstRaisedAt)}
              >
                {closed
                  ? timeAgo(r.closedAt)
                  : formatDuration(Date.now() - Date.parse(r.firstRaisedAt))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function FollowUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  if (!can(user.role, "alerts.track")) return <NoAccess role={user.role} what="alert follow-up" />;
  const params = await searchParams;
  const days = PERIODS.find((p) => String(p) === params.days) ?? 30;
  const res = await apiGet(`/alert-tracking?days=${days}`, AlertTrackingReport, await apiAuth(), {
    timeoutMs: 15_000,
  });
  if (!res.ok)
    return (
      <Notice tone="error">The follow-up report couldn&apos;t be loaded. Refresh the page.</Notice>
    );
  const r = res.data;
  const t = r.totals;
  const awaiting = r.open.filter((a) => a.status === "RESOLVED");
  const open = r.open.filter((a) => a.status !== "RESOLVED");

  const tiles: { label: string; value: string; note: string; tone?: string }[] = [
    {
      label: "Open now",
      value: String(t.openNow),
      note: `${t.criticalOpenNow} critical · ${t.unseenOpenNow} nobody has seen`,
      tone: t.criticalOpenNow ? "text-destructive" : t.openNow ? "text-warning" : "",
    },
    {
      label: "Fixes awaiting check",
      value: String(t.awaitingCheck),
      note: "Reported fixed, not yet confirmed",
    },
    {
      label: "Fix accuracy",
      value: t.accuracy === null ? "—" : `${Math.round(t.accuracy * 100)}%`,
      note: `${t.confirmed} held · ${t.rejected} didn't`,
      tone:
        t.accuracy === null
          ? ""
          : t.accuracy >= 0.8
            ? "text-success"
            : t.accuracy >= 0.5
              ? "text-warning"
              : "text-destructive",
    },
    {
      label: "Time to first look",
      value: formatDuration(t.medianSeenMs),
      note: "Median, raised → seen",
    },
    {
      label: "Time to take",
      value: formatDuration(t.medianAckMs),
      note: "Median, raised → someone on it",
    },
    {
      label: "Time to fix",
      value: formatDuration(t.medianResolveMs),
      note: "Median, raised → fix reported",
    },
  ];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Alert follow-up</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Who saw each alert, who took it, what they did and whether the fix held. Malware,
            uptime, SSL, domain, backup, restore and file checks confirm fixes by themselves; the
            rest wait for you. Only Super Admins see this page.
          </p>
        </div>
        <nav aria-label="Period" className="inline-flex rounded-md border p-0.5">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={`/follow-up?days=${p}`}
              aria-current={p === days ? "page" : undefined}
              className={cn(
                "rounded px-3 py-1 text-sm",
                p === days
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p} days
            </Link>
          ))}
        </nav>
      </div>

      <section
        aria-label="Summary"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6"
      >
        {tiles.map((tile) => (
          <Card key={tile.label} className="p-4">
            <p className="text-xs text-muted-foreground">{tile.label}</p>
            <p className={cn("mt-1 text-2xl font-semibold tracking-tight", tile.tone)}>
              {tile.value}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">{tile.note}</p>
          </Card>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Follow-up steps</CardTitle>
            <CardDescription>
              {t.actionable} alerts needing action in the last {days} days, and how far they got.
              {t.autoCleared > 0 &&
                ` ${t.autoCleared} cleared on their own before anyone fixed them.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FunnelChart steps={r.funnel} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Raised vs closed per day</CardTitle>
            <CardDescription>
              Closed = fix confirmed or cleared on its own. A gap that keeps growing means alerts
              pile up.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DailyChart days={r.daily} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team</CardTitle>
          <CardDescription>
            Per member, for alerts raised in the last {days} days. Accuracy = fixes that held ÷
            fixes that were checked. A fix &ldquo;didn&apos;t hold&rdquo; when the next check still
            found the problem or a Super Admin reopened it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {r.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No alerts went out in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Member</th>
                    <th className="py-2 pr-3 font-medium">Seen</th>
                    <th
                      className="py-2 pr-3 font-medium"
                      title="Open alerts they received and never looked at"
                    >
                      Not looked at
                    </th>
                    <th className="py-2 pr-3 font-medium">Took</th>
                    <th className="py-2 pr-3 font-medium">Fixes</th>
                    <th className="py-2 pr-3 font-medium">Held / didn&apos;t / pending</th>
                    <th className="py-2 pr-3 font-medium">Accuracy</th>
                    <th className="py-2 font-medium">Time to fix</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {r.members.map((m) => (
                    <tr key={m.userId}>
                      <td className="py-2 pr-3">
                        <p className="font-medium">{m.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {ROLE_LABELS[m.role as keyof typeof ROLE_LABELS] ?? m.role}
                        </p>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {m.seen} of {m.received}
                        <p className="text-xs text-muted-foreground">
                          median {formatDuration(m.medianSeenMs)}
                        </p>
                      </td>
                      <td
                        className={cn(
                          "py-2 pr-3 tabular-nums",
                          m.ignoredOpen > 0 && "font-medium text-destructive",
                        )}
                      >
                        {m.ignoredOpen}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{m.acknowledged}</td>
                      <td className="py-2 pr-3 tabular-nums">{m.resolved}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        <span className="text-success">{m.confirmed}</span> /{" "}
                        <span className={cn(m.rejected > 0 && "text-destructive")}>
                          {m.rejected}
                        </span>{" "}
                        / <span className="text-muted-foreground">{m.pending}</span>
                      </td>
                      <td className="py-2 pr-3">
                        <Meter value={m.accuracy} label={`${m.name}'s fix accuracy`} />
                      </td>
                      <td className="py-2 tabular-nums">{formatDuration(m.medianResolveMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {awaiting.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Fixes waiting for a check ({awaiting.length})
            </CardTitle>
            <CardDescription>
              Someone reported these fixed. Open one to see what they did and confirm or reject it;
              automatic checks confirm the rest on their next run.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertTable rows={awaiting} empty="" />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Still open ({open.length})</CardTitle>
          <CardDescription>
            Critical first, then oldest. &ldquo;{ALERT_STATUS_LABELS.OPEN}&rdquo; means nobody has
            taken it yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AlertTable rows={open} empty="Nothing open. Every alert has been handled." />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recently closed</CardTitle>
          <CardDescription>
            Closed in the last {days} days, newest first (up to 50).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AlertTable rows={r.recent} empty="Nothing was closed in this period." closed />
        </CardContent>
      </Card>
    </div>
  );
}
