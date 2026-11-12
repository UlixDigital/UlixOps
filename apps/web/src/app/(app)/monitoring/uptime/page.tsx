// Monitoring → Uptime (Phase 3 step 2, A149): every production site checked every 5 minutes,
// response time, uptime over 24 h / 7 / 30 days, and the outage history.
import { isClientViewer, UptimeOverview, uptimePercent } from "@ulixops/shared";
import type { Metadata } from "next";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { percentText } from "@/components/uptime-badge";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MonitoringTabs } from "../monitoring-tabs";
import { IncidentsTable } from "./incidents-table";
import { UptimeTable } from "./uptime-table";

export const metadata: Metadata = { title: "Uptime · UlixOps" };

export default async function UptimePage() {
  const { user } = await requireSession();
  const res = await apiGet("/monitoring/uptime", UptimeOverview, await apiAuth(), {
    timeoutMs: 15_000,
  });
  const header = (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Monitoring</h1>
        <p className="text-sm text-muted-foreground">
          Each site&apos;s homepage is loaded every 5 minutes, the way a visitor would. Two failed
          checks in a row count as down and send an alert; another goes out when it&apos;s back.
        </p>
      </div>
      <MonitoringTabs active="/monitoring/uptime" showVisual={!isClientViewer(user.role)} />
    </>
  );
  if (!res.ok)
    return (
      <div className="grid gap-4">
        {header}
        <Notice tone="error">Uptime couldn&apos;t be loaded. Refresh the page.</Notice>
      </div>
    );
  const { sites, incidents, status } = res.data;
  const monitored = sites.filter((s) => s.state !== "paused");
  const downNow = sites.filter((s) => s.state === "down").length;
  const month = monitored.reduce(
    (t, s) => ({ checks: t.checks + s.month.checks, failed: t.failed + s.month.failed }),
    { checks: 0, failed: 0 },
  );
  const monthPercent = uptimePercent(month.checks, month.failed);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
  const tiles = [
    { label: "Down now", value: String(downNow), tone: downNow ? "text-destructive" : "" },
    {
      label: "Up",
      value: `${monitored.filter((s) => s.state === "up").length} / ${monitored.length}`,
      tone: "",
    },
    { label: "Uptime, 30 days (all sites)", value: percentText(monthPercent), tone: "" },
    {
      label: "Incidents, 7 days",
      value: String(incidents.filter((i) => Date.parse(i.startedAt) >= weekAgo).length),
      tone: "",
    },
  ];

  return (
    <div className="grid gap-4">
      <LiveRefresh intervalMs={status.running ? 3_000 : 60_000} />
      {header}
      {status.ok === false && (
        <Notice tone="error">
          The last scheduled check failed ({status.error ?? "unknown error"}). It runs again in 5
          minutes.
        </Notice>
      )}
      <section aria-label="Uptime summary" className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className={cn("mt-1 text-2xl font-semibold tracking-tight", t.tone)}>{t.value}</p>
          </Card>
        ))}
        <Card className="col-span-2 p-4 md:col-span-1">
          <p className="text-xs text-muted-foreground">Last check</p>
          <p className="mt-1 text-sm font-medium" title={formatUtc(status.lastSuccessAt)}>
            {status.running
              ? "Checking now…"
              : status.lastSuccessAt
                ? timeAgo(status.lastSuccessAt)
                : "Not yet"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Every {res.data.intervalMinutes} minutes, production sites
          </p>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sites</CardTitle>
          <CardDescription>
            Down sites first. Any answer below HTTP 500 counts as up (a password-protected site
            still answers); 5xx errors, WordPress error pages, timeouts and connection failures
            count as down. Checks while UlixOps itself is deploying or updating a site don&apos;t
            count.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UptimeTable rows={sites} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Incidents</CardTitle>
          <CardDescription>Outages in the last 30 days, ongoing first.</CardDescription>
        </CardHeader>
        <CardContent>
          <IncidentsTable rows={incidents} />
        </CardContent>
      </Card>
    </div>
  );
}
