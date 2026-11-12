// One alert's follow-up (A158): steps with timings, who saw it, the full timeline, what was
// recorded on the site meanwhile, and the Super Admin's confirm / reject.
import {
  ALERT_EVENT_LABELS,
  ALERT_RESOLUTION_LABELS,
  AlertDetail,
  can,
  FIX_ACTION_LABELS,
  NOTIFICATION_EVENT_LABELS,
  RecordId,
} from "@ulixops/shared";
import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertStatusBadge, formatDuration, SEVERITY_BADGE } from "@/components/alert-status";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { ROLE_LABELS, formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Alert follow-up · UlixOps" };

const since = (from: string, to: string | null) =>
  to ? formatDuration(Date.parse(to) - Date.parse(from)) : null;

export default async function AlertFollowUpPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireSession();
  if (!can(user.role, "alerts.track")) return <NoAccess role={user.role} what="alert follow-up" />;
  const id = RecordId.safeParse((await params).id);
  if (!id.success) notFound();
  const res = await apiGet(`/alert-tracking/${id.data}`, AlertDetail, await apiAuth());
  if (!res.ok) {
    if (res.error === "not_found") notFound();
    return <Notice tone="error">This alert couldn&apos;t be loaded. Refresh the page.</Notice>;
  }
  const { alert: a, recipients, events, evidence } = res.data;
  const firstFix = events.find((e) => e.type === "RESOLVED")?.createdAt ?? null;
  const confirmed = a.status === "VERIFIED" ? a.verifiedAt : null;

  const steps = a.actionable
    ? [
        { label: "Raised", at: a.firstRaisedAt, who: null as string | null },
        {
          label: "First seen",
          at: a.firstSeenAt,
          who: `${a.seenBy} of ${a.recipients} have seen it`,
        },
        { label: "Someone took it", at: a.acknowledgedAt, who: a.ownerName },
        { label: "Fix reported", at: a.resolvedAt ?? firstFix, who: a.resolvedByName },
        {
          label: a.status === "AUTO_CLEARED" ? "Cleared on its own" : "Fix confirmed",
          at: a.status === "AUTO_CLEARED" ? a.closedAt : confirmed,
          who:
            a.status === "AUTO_CLEARED"
              ? "Nobody fixed it"
              : confirmed
                ? (a.verifiedByName ?? "UlixOps re-check")
                : null,
        },
      ]
    : [
        { label: "Sent", at: a.firstRaisedAt, who: null },
        {
          label: "First seen",
          at: a.firstSeenAt,
          who: `${a.seenBy} of ${a.recipients} have seen it`,
        },
      ];

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link href="/follow-up" className="text-sm text-link hover:underline">
          ← Alert follow-up
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-xs font-semibold uppercase",
              SEVERITY_BADGE[a.severity],
            )}
          >
            {a.severity}
          </span>
          <AlertStatusBadge status={a.status} />
          <span className="text-xs text-muted-foreground">{NOTIFICATION_EVENT_LABELS[a.kind]}</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{a.title}</h1>
        <p className="text-sm text-muted-foreground">
          {[
            a.siteNames.length ? a.siteNames.join(", ") : "Hub-wide",
            a.occurrences > 1
              ? `reported ${a.occurrences} times, last ${timeAgo(a.lastRaisedAt)}`
              : null,
            a.reopenCount > 0 ? `reopened ${a.reopenCount}×` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Steps</CardTitle>
          <CardDescription>Times are from when the alert was first raised.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-4 sm:grid-cols-5">
            {steps.map((s, i) => {
              const done = Boolean(s.at);
              return (
                <li key={s.label} className="flex gap-3 sm:grid sm:gap-2">
                  <div className="flex items-center gap-2 sm:w-full">
                    <span
                      className={cn(
                        "inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                        done
                          ? "border-primary bg-primary text-primary-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {done ? <Check aria-hidden className="size-3.5" /> : i + 1}
                    </span>
                    {i < steps.length - 1 && (
                      <span
                        aria-hidden
                        className={cn(
                          "hidden h-px flex-1 sm:block",
                          done ? "bg-primary" : "bg-border",
                        )}
                      />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className={cn("text-sm font-medium", !done && "text-muted-foreground")}>
                      {s.label}
                    </p>
                    {s.at ? (
                      <p className="text-xs text-muted-foreground" title={formatUtc(s.at)}>
                        {i === 0 ? formatUtc(s.at) : `after ${since(a.firstRaisedAt, s.at)}`}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">Not yet</p>
                    )}
                    {s.who && <p className="text-xs text-muted-foreground">{s.who}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Alert</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm break-words whitespace-pre-line text-muted-foreground">
              {a.body}
            </p>
          </CardContent>
        </Card>

        {a.actionable && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Fix</CardTitle>
              <CardDescription>
                {a.autoVerify
                  ? "UlixOps re-checks this kind of problem: a clean check confirms the fix, a failing one reopens the alert."
                  : "UlixOps can't re-check this kind of problem: a Super Admin confirms the fix."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {a.resolvedByName ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">By</dt>
                  <dd>{a.resolvedByName}</dd>
                  <dt className="text-muted-foreground">Outcome</dt>
                  <dd>{a.resolution ? ALERT_RESOLUTION_LABELS[a.resolution] : "—"}</dd>
                  <dt className="text-muted-foreground">What they did</dt>
                  <dd>{a.fixAction ? FIX_ACTION_LABELS[a.fixAction] : "—"}</dd>
                  <dt className="text-muted-foreground">Details</dt>
                  <dd className="break-words whitespace-pre-line">{a.resolutionNote ?? "—"}</dd>
                  {a.verifiedAt && (
                    <>
                      <dt className="text-muted-foreground">Confirmed</dt>
                      <dd>
                        {a.verifiedByName ? `by ${a.verifiedByName}` : "by UlixOps' re-check"},{" "}
                        <span title={formatUtc(a.verifiedAt)}>{timeAgo(a.verifiedAt)}</span>
                      </dd>
                    </>
                  )}
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {a.status === "AUTO_CLEARED"
                    ? "The problem went away before anyone reported a fix."
                    : a.ownerName
                      ? `${a.ownerName} is working on it; no fix reported yet.`
                      : "Nobody has taken this alert yet."}
                </p>
              )}
              {a.status === "RESOLVED" && <VerifyForm alertId={a.id} mode="verify" />}
              {(a.status === "VERIFIED" || a.status === "AUTO_CLEARED") && (
                <details className="rounded-md border px-3 py-2">
                  <summary className="cursor-pointer text-sm font-medium">
                    Problem is back? Reopen it
                  </summary>
                  <div className="mt-3">
                    <VerifyForm alertId={a.id} mode="reopen" />
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who saw it</CardTitle>
          <CardDescription>
            &ldquo;Seen&rdquo; = they opened the bell, clicked the popup or opened Notifications. A
            popup on an unattended screen doesn&apos;t count.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Member</th>
                <th className="py-2 pr-3 font-medium">Sent</th>
                <th className="py-2 pr-3 font-medium">Seen</th>
                <th className="py-2 font-medium">Marked read</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {recipients.map((p) => (
                <tr key={p.userId}>
                  <td className="py-2 pr-3">
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {ROLE_LABELS[p.role as keyof typeof ROLE_LABELS] ?? p.role}
                    </p>
                  </td>
                  <td className="py-2 pr-3 text-xs" title={formatUtc(p.deliveredAt)}>
                    {timeAgo(p.deliveredAt)}
                  </td>
                  <td className="py-2 pr-3 text-xs" title={formatUtc(p.seenAt)}>
                    {p.seenAt ? (
                      `after ${since(p.deliveredAt, p.seenAt)}`
                    ) : (
                      <span className="font-medium text-destructive">Not seen</span>
                    )}
                  </td>
                  <td className="py-2 text-xs" title={formatUtc(p.readAt)}>
                    {p.readAt ? `after ${since(p.deliveredAt, p.readAt)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timeline</CardTitle>
            <CardDescription>
              Every step, oldest first. This history can&apos;t be edited.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="grid gap-3 border-l pl-4">
              {events.map((e) => (
                <li key={e.id} className="relative">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute top-1.5 -left-[1.3rem] size-2 rounded-full",
                      e.type === "REJECTED"
                        ? "bg-destructive"
                        : e.type === "CONFIRMED"
                          ? "bg-success"
                          : e.type === "SEEN" || e.type === "READ"
                            ? "bg-border"
                            : "bg-primary",
                    )}
                  />
                  <p className="text-sm">
                    <span className="font-medium">{ALERT_EVENT_LABELS[e.type]}</span>
                    {" · "}
                    {e.actorName ?? "UlixOps"}
                    {e.subjectName && (e.type === "CONFIRMED" || e.type === "REJECTED")
                      ? ` (fix by ${e.subjectName})`
                      : ""}
                  </p>
                  <p className="text-xs text-muted-foreground" title={formatUtc(e.createdAt)}>
                    {formatUtc(e.createdAt)}
                  </p>
                  {e.note && (
                    <p className="mt-0.5 text-xs break-words whitespace-pre-line text-muted-foreground">
                      {e.note}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recorded on the site meanwhile</CardTitle>
            <CardDescription>
              Audit log entries for these sites (and by the people handling the alert) from when it
              was raised until an hour after it closed. Use it to check the reported fix against
              what actually happened in UlixOps.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing recorded. A fix done outside UlixOps (at the host, over SFTP) leaves no
                entry here.
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {evidence.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 py-1.5"
                  >
                    <span>
                      <span className="font-mono text-xs">{e.action}</span>{" "}
                      <span className="text-xs text-muted-foreground">
                        {e.result} · {e.userName ?? "UlixOps"}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground" title={formatUtc(e.createdAt)}>
                      {timeAgo(e.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
