// Site "Uptime & SSL" tab, uptime part (P3-2, A149): status, response time, uptime windows,
// the last 24 hours by hour, Check now, pause / resume and this site's incidents.
import type { SiteUptimeView } from "@ulixops/shared";
import Link from "next/link";
import { checkSiteUptimeAction, setUptimeEnabledAction } from "@/app/(app)/monitoring/actions";
import { IncidentsTable } from "@/app/(app)/monitoring/uptime/incidents-table";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import {
  msText,
  percentText,
  percentTone,
  UptimeBadge,
  UptimeHoursStrip,
} from "@/components/uptime-badge";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export function UptimeCard({
  siteId,
  data,
  canCheck,
  canManage,
}: {
  siteId: string;
  data: SiteUptimeView | null;
  canCheck: boolean;
  canManage: boolean;
}) {
  const m = data?.monitor ?? null;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle className="text-base">Uptime</CardTitle>
          <CardDescription>
            The production homepage, loaded every {data?.intervalMinutes ?? 5} minutes. Two failed
            checks in a row send a &ldquo;down&rdquo; alert, and another goes out when it&apos;s
            back.{" "}
            <Link href="/monitoring/uptime" className="text-link hover:underline">
              All sites
            </Link>
          </CardDescription>
        </div>
        {m && (
          <div className="flex flex-wrap gap-2">
            {canCheck && m.enabled && !data?.status.running && (
              <ActionForm
                action={checkSiteUptimeAction}
                submitLabel="Check now"
                variant="outline"
                pendingLabel="Starting…"
              >
                <input type="hidden" name="siteId" value={siteId} />
              </ActionForm>
            )}
            {canManage && (
              <ActionForm
                action={setUptimeEnabledAction}
                submitLabel={m.enabled ? "Pause monitoring" : "Resume monitoring"}
                variant="outline"
                confirm={
                  m.enabled
                    ? {
                        title: "Pause uptime monitoring?",
                        description:
                          "No checks and no down alerts for this site until you resume. An ongoing outage is closed as “monitoring paused”.",
                      }
                    : undefined
                }
              >
                <input type="hidden" name="siteId" value={siteId} />
                <input type="hidden" name="enabled" value={m.enabled ? "false" : "true"} />
              </ActionForm>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {!data ? (
          <Notice tone="error">Uptime couldn&apos;t be loaded. Refresh the page.</Notice>
        ) : !m ? (
          <p className="text-sm text-muted-foreground">This site has no production environment.</p>
        ) : (
          <>
            {data.status.running && <p className="text-sm text-muted-foreground">Checking now…</p>}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <UptimeBadge state={m.state} since={m.downSince} />
              {m.state === "paused" ? (
                <span className="text-muted-foreground">
                  Monitoring is paused{canManage ? "" : "; an Admin can resume it"}.
                </span>
              ) : m.checkedAt ? (
                <>
                  {!m.error && m.responseMs !== null && (
                    <span className="tabular-nums">{msText(m.responseMs)}</span>
                  )}
                  {m.status !== null && (
                    <span className="text-muted-foreground">HTTP {m.status}</span>
                  )}
                  <span className="text-muted-foreground" title={formatUtc(m.checkedAt)}>
                    checked {timeAgo(m.checkedAt)}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  The first check runs within {data.intervalMinutes} minutes.
                </span>
              )}
            </div>
            {m.error && m.state !== "paused" && (
              <p className="text-xs text-destructive">
                {m.state === "up"
                  ? `The last check failed (${m.error}). One more failure in a row counts as down.`
                  : m.error}
              </p>
            )}
            <dl className="grid grid-cols-3 gap-3 sm:max-w-md">
              {(
                [
                  ["24 hours", m.day],
                  ["7 days", m.week],
                  ["30 days", m.month],
                ] as const
              ).map(([label, w]) => (
                <div key={label} className="rounded-md border p-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd
                    className={cn(
                      "mt-1 text-lg font-semibold tabular-nums",
                      percentTone(w.percent),
                    )}
                  >
                    {percentText(w.percent)}
                  </dd>
                  <dd className="text-[11px] text-muted-foreground">
                    {w.avgResponseMs !== null ? `${msText(w.avgResponseMs)} average` : "No data"}
                  </dd>
                </div>
              ))}
            </dl>
            <UptimeHoursStrip hours={data.hours} />
            <div className="grid gap-2">
              <h3 className="text-sm font-medium">Incidents, last 30 days</h3>
              <IncidentsTable rows={data.incidents} showSite={false} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
