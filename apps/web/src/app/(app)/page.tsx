import {
  AlertList,
  ApprovalList,
  AuditPage,
  can,
  DeploymentList,
  ErrorLogOverview,
  ExpiryOverview,
  FullBackupList,
  IntegrityOverview,
  isClientViewer,
  MalwareOverview,
  SiteList,
  UptimeOverview,
  VulnFindingList,
} from "@ulixops/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CountBars,
  expirySegments,
  RingStat,
  SegmentBar,
  SeverityBars,
  StatMeter,
  uptimeSegments,
} from "@/components/dashboard/charts";
import { StatCard } from "@/components/dashboard/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet, apiHealthy } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import {
  attentionItems,
  auditCategory,
  avgUptimePercent24h,
  bucketExpiry,
  countByLabel,
  countUptimeStates,
  downSites,
  infectedSites,
  integrityChangedSites,
  outdatedPhpCount,
  phpFatalSites,
  toneForCount,
  updatesPending,
  vulnBySeverity,
  worstOpenVulns,
  type StatTone,
} from "@/lib/dashboard";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const ALERT_LABELS: Record<string, string> = {
  NEW_DEVICE_LOGIN: "New device sign-in",
  ACCOUNT_LOCKED: "Account locked",
  ADMIN_ROLE_GRANTED: "Admin role granted",
  TWO_FACTOR_RESET: "2FA reset",
  HOST_KEY_MISMATCH: "Host key changed",
};

const DEPLOY_TONE: Record<string, StatTone> = {
  RUNNING: "warn",
  QUEUED: "neutral",
  PAUSED: "warn",
  PENDING_APPROVAL: "warn",
  SUCCEEDED: "ok",
  FAILED: "bad",
  ROLLED_BACK: "bad",
  CANCELLED: "neutral",
};

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : String(n);
}

function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sm text-link hover:underline">
      {children}
    </Link>
  );
}

export default async function DashboardPage() {
  const { user } = await requireSession();
  const admin = can(user.role, "audit.view");
  const canSites = can(user.role, "sites.view");
  const clientViewer = isClientViewer(user.role);
  const auth = await apiAuth();
  const [
    healthy,
    alerts,
    activity,
    sites,
    approvals,
    deployments,
    expiry,
    uptime,
    backups,
    vulns,
    malware,
    integrity,
    phpErrors,
  ] = await Promise.all([
    apiHealthy(),
    admin ? apiGet("/alerts?limit=20", AlertList, auth) : null,
    admin ? apiGet("/audit?limit=12", AuditPage, auth) : null,
    canSites ? apiGet("/sites", SiteList, auth) : null,
    can(user.role, "approvals.decide") ? apiGet("/approvals", ApprovalList, auth) : null,
    can(user.role, "deployments.view") ? apiGet("/deployments", DeploymentList, auth) : null,
    canSites ? apiGet("/monitoring/expiry", ExpiryOverview, auth) : null,
    canSites ? apiGet("/monitoring/uptime", UptimeOverview, auth) : null,
    canSites && !clientViewer
      ? apiGet("/full-backups?status=READY&limit=1", FullBackupList, auth)
      : null,
    canSites ? apiGet("/vulnerabilities", VulnFindingList, auth) : null,
    canSites ? apiGet("/malware-scans/overview", MalwareOverview, auth) : null,
    canSites ? apiGet("/integrity-checks/overview", IntegrityOverview, auth) : null,
    canSites ? apiGet("/monitoring/php-errors", ErrorLogOverview, auth) : null,
  ]);

  const newestBackup = backups?.ok ? backups.data.backups[0] : undefined;
  const allDeploys = deployments?.ok ? deployments.data.deployments : [];
  const live = allDeploys.filter((d) =>
    ["QUEUED", "RUNNING", "PAUSED", "PENDING_APPROVAL"].includes(d.status),
  );
  const waiting = approvals?.ok ? approvals.data.pending : null;

  const sitesData = sites?.ok ? sites.data : null;
  const uptimeData = uptime?.ok ? uptime.data : null;
  const expiryData = expiry?.ok ? expiry.data : null;
  const vulnsData = vulns?.ok ? vulns.data : null;
  const malwareData = malware?.ok ? malware.data : null;
  const integrityData = integrity?.ok ? integrity.data : null;
  const phpData = phpErrors?.ok ? phpErrors.data : null;
  const alertRows = alerts?.ok ? alerts.data.alerts : [];
  const activityRows = activity?.ok ? activity.data.entries : [];

  const down = uptimeData ? countUptimeStates(uptimeData).down : null;
  const openVulnCount = vulnsData
    ? Object.values(vulnBySeverity(vulnsData)).reduce((a, b) => a + b, 0)
    : null;
  const updates = sitesData ? updatesPending(sitesData) : null;
  const phpOut = sitesData ? outdatedPhpCount(sitesData) : null;
  const expiryBuckets = expiryData ? bucketExpiry(expiryData) : null;
  const expiringSoon = expiryBuckets
    ? expiryBuckets.soon30 + expiryBuckets.soon7 + expiryBuckets.broken
    : null;
  const infected = malwareData?.stats.infected ?? null;
  const changed = integrityData?.stats.changed ?? null;
  const securityProblems =
    infected !== null && changed !== null
      ? infected + changed
      : infected !== null
        ? infected
        : changed;

  const uptimeCounts = uptimeData ? countUptimeStates(uptimeData) : null;
  const avgPct = uptimeData ? avgUptimePercent24h(uptimeData) : null;
  const downList = uptimeData ? downSites(uptimeData) : [];
  const sevCounts = vulnsData ? vulnBySeverity(vulnsData) : null;
  const worstVulns = vulnsData ? worstOpenVulns(vulnsData, 4) : [];
  const fatalRows = phpData ? phpFatalSites(phpData).slice(0, 6) : [];
  const attention = attentionItems({
    uptime: uptimeData,
    expiry: expiryData,
    vulns: vulnsData,
    malware: malwareData,
    integrity: integrityData,
    sites: sitesData,
  });

  const malwareTotal = malwareData
    ? malwareData.stats.clean +
      malwareData.stats.infected +
      malwareData.stats.failed +
      malwareData.stats.neverScanned
    : 0;
  const integrityTotal = integrityData
    ? integrityData.stats.clean +
      integrityData.stats.changed +
      integrityData.stats.failed +
      integrityData.stats.neverChecked
    : 0;

  const deployStatusRows = countByLabel(allDeploys, (d) => d.status.replaceAll("_", " ")).map(
    (row) => ({
      ...row,
      tone: DEPLOY_TONE[row.key.toUpperCase().replaceAll(" ", "_")] ?? ("neutral" as StatTone),
    }),
  );
  const alertKindRows = countByLabel(alertRows, (a) => ALERT_LABELS[a.kind] ?? a.kind);
  const activityCats = countByLabel(activityRows, (e) => auditCategory(e.action));
  const phpBars = fatalRows.map((r) => ({
    key: r.siteId,
    label: r.siteName,
    count: r.fatal24h + r.warnings24h,
    tone: (r.fatal24h > 0 ? "bad" : "warn") as StatTone,
  }));

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome{user.name ? `, ${user.name}` : ""}.{" "}
            {clientViewer && user.viewTag
              ? `Viewing tag: ${user.viewTag}.`
              : "Fleet health at a glance."}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
            healthy ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          API {healthy ? "healthy" : "unreachable"}
        </span>
      </div>

      {canSites && (
        <>
          <section aria-label="Overview" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="Sites"
              value={fmt(sitesData?.sites.length ?? null)}
              hint="Active sites"
              href="/sites"
            />
            <StatCard
              label="Sites down"
              value={fmt(down)}
              hint="Production, every 5 min"
              tone={toneForCount(down, { warnAt: 1, badAt: 1 })}
              href="/monitoring/uptime"
            />
            <StatCard
              label="Open vulns"
              value={fmt(openVulnCount)}
              hint="Current open findings"
              tone={toneForCount(openVulnCount, { warnAt: 1, badAt: 1 })}
              href="/security"
            />
            <StatCard
              label="Updates pending"
              value={fmt(updates)}
              hint="Core, plugins, themes"
              tone={toneForCount(updates, { warnAt: 1, badAt: 20 })}
              href="/plugins"
            />
            <StatCard
              label="Outdated PHP"
              value={fmt(phpOut)}
              hint="EOL or ending ≤ 6 months"
              tone={toneForCount(phpOut, { warnAt: 1, badAt: 1 })}
              href="/sites"
            />
            <StatCard
              label="Expiring soon"
              value={fmt(expiringSoon)}
              hint="SSL & domains ≤ 30 days"
              tone={toneForCount(expiringSoon, { warnAt: 1, badAt: 1 })}
              href="/monitoring/ssl"
            />
            <StatCard
              label="Infected / changed"
              value={fmt(securityProblems)}
              hint="Malware + integrity"
              tone={toneForCount(securityProblems, { warnAt: 1, badAt: 1 })}
              href="/security/malware"
            />
            <StatCard
              label="Last backup"
              value={
                newestBackup ? timeAgo(newestBackup.finishedAt ?? newestBackup.startedAt) : "—"
              }
              hint="Newest ready on Drive"
              href="/backups"
            />
          </section>

          <section aria-label="Health charts" className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="grid gap-1">
                  <CardTitle className="text-base">Uptime</CardTitle>
                  <CardDescription>
                    {avgPct !== null ? `Fleet · ${avgPct}% avg (24 h)` : "Fleet status"}
                  </CardDescription>
                </div>
                <PanelLink href="/monitoring/uptime">Open</PanelLink>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
                {uptimeCounts ? (
                  <>
                    <RingStat
                      value={uptimeCounts.up}
                      total={
                        uptimeCounts.up +
                        uptimeCounts.down +
                        uptimeCounts.paused +
                        uptimeCounts.unknown
                      }
                      label="Sites up"
                      hint={
                        uptimeCounts.down > 0
                          ? `${uptimeCounts.down} down now`
                          : "All monitored sites answering"
                      }
                      tone={uptimeCounts.down > 0 ? "bad" : "ok"}
                    />
                    <div className="grid gap-3">
                      <SegmentBar
                        segments={uptimeSegments(uptimeCounts)}
                        ariaLabel="Sites by uptime state"
                      />
                      {downList.length > 0 && (
                        <ul className="grid gap-1 text-sm">
                          {downList.slice(0, 4).map((s) => (
                            <li key={s.siteId}>
                              <Link
                                href={`/sites/${s.siteId}/monitoring`}
                                className="text-destructive hover:underline"
                              >
                                {s.siteName} is down
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Uptime data unavailable.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="grid gap-1">
                  <CardTitle className="text-base">SSL & domains</CardTitle>
                  <CardDescription>Expiry risk across the fleet</CardDescription>
                </div>
                <PanelLink href="/monitoring/ssl">Open</PanelLink>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
                {expiryBuckets ? (
                  <>
                    <RingStat
                      value={expiringSoon ?? 0}
                      total={Math.max(
                        1,
                        expiryBuckets.ok +
                          expiryBuckets.soon30 +
                          expiryBuckets.soon7 +
                          expiryBuckets.broken,
                      )}
                      label="Need attention"
                      hint="Broken or ≤ 30 days"
                      tone={toneForCount(expiringSoon, { warnAt: 1, badAt: 1 })}
                    />
                    <SegmentBar
                      segments={expirySegments(expiryBuckets)}
                      ariaLabel="SSL and domain expiry buckets"
                    />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Expiry data unavailable.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="grid gap-1">
                  <CardTitle className="text-base">Vulnerabilities</CardTitle>
                  <CardDescription>
                    Open by severity
                    {openVulnCount !== null ? ` · ${openVulnCount}` : ""}
                  </CardDescription>
                </div>
                <PanelLink href="/security">Open</PanelLink>
              </CardHeader>
              <CardContent className="grid gap-4">
                {sevCounts ? (
                  <SeverityBars counts={sevCounts} />
                ) : (
                  <p className="text-sm text-muted-foreground">Vulnerability data unavailable.</p>
                )}
                {worstVulns.length > 0 && (
                  <ul className="grid gap-2 border-t pt-3 text-sm">
                    {worstVulns.map((f) => (
                      <li key={f.id} className="flex items-start justify-between gap-3">
                        <Link href="/security" className="min-w-0 hover:underline">
                          <span className="capitalize text-muted-foreground">{f.severity}</span>
                          {" · "}
                          {f.siteName}
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {f.slug}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="grid gap-1">
                  <CardTitle className="text-base">Malware & integrity</CardTitle>
                  <CardDescription>Latest scan results per site</CardDescription>
                </div>
                <PanelLink href="/security/malware">Open</PanelLink>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {malwareData ? (
                  <div className="grid gap-3">
                    <RingStat
                      value={malwareData.stats.infected}
                      total={malwareTotal || 1}
                      label="Infected"
                      hint={`${malwareData.stats.clean} clean · ${malwareData.stats.neverScanned} never`}
                      tone={malwareData.stats.infected > 0 ? "bad" : "ok"}
                    />
                    <StatMeter
                      label="Never scanned"
                      value={malwareData.stats.neverScanned}
                      total={malwareTotal || 1}
                      tone={malwareData.stats.neverScanned > 0 ? "warn" : "ok"}
                    />
                    {infectedSites(malwareData)
                      .slice(0, 3)
                      .map((s) => (
                        <Link
                          key={s.siteId}
                          href={`/sites/${s.siteId}/security`}
                          className="text-sm text-destructive hover:underline"
                        >
                          {s.siteName}
                        </Link>
                      ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Malware data unavailable.</p>
                )}
                {integrityData ? (
                  <div className="grid gap-3">
                    <RingStat
                      value={integrityData.stats.changed}
                      total={integrityTotal || 1}
                      label="Changed"
                      hint={`${integrityData.stats.clean} clean · ${integrityData.stats.neverChecked} never`}
                      tone={integrityData.stats.changed > 0 ? "warn" : "ok"}
                    />
                    <StatMeter
                      label="Never checked"
                      value={integrityData.stats.neverChecked}
                      total={integrityTotal || 1}
                      tone={integrityData.stats.neverChecked > 0 ? "warn" : "ok"}
                    />
                    {integrityChangedSites(integrityData)
                      .slice(0, 3)
                      .map((s) => (
                        <Link
                          key={s.siteId}
                          href="/security/integrity"
                          className="text-sm text-warning hover:underline"
                        >
                          {s.siteName}
                        </Link>
                      ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Integrity data unavailable.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="grid gap-1">
                  <CardTitle className="text-base">PHP errors (24 h)</CardTitle>
                  <CardDescription>Fatals and warnings on production</CardDescription>
                </div>
                <PanelLink href="/monitoring/php-errors">Open</PanelLink>
              </CardHeader>
              <CardContent>
                {phpBars.length > 0 ? (
                  <CountBars rows={phpBars} ariaLabel="PHP errors by site" />
                ) : phpData ? (
                  <RingStat
                    value={0}
                    total={1}
                    label="Quiet"
                    hint="No fatals or warnings in the last 24 hours"
                    tone="ok"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">PHP error data unavailable.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="grid gap-1">
                  <CardTitle className="text-base">Needs attention</CardTitle>
                  <CardDescription>Highest-priority open problems</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                <RingStat
                  value={attention.length}
                  total={Math.max(10, attention.length)}
                  label={attention.length === 0 ? "All clear" : "Open items"}
                  hint={
                    attention.length === 0
                      ? "Nothing urgent right now"
                      : "Down, malware, integrity, critical vulns, expiry, PHP"
                  }
                  tone={toneForCount(attention.length, { warnAt: 1, badAt: 3 })}
                />
                {attention.length > 0 && (
                  <ul className="grid gap-2 border-t pt-3 text-sm">
                    {attention.map((item) => (
                      <li key={item.id}>
                        <Link
                          href={item.href}
                          className={cn(
                            "hover:underline",
                            item.tone === "bad" && "text-destructive",
                            item.tone === "warn" && "text-warning",
                          )}
                        >
                          {item.reason}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>
        </>
      )}

      <section aria-label="Ops" className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div className="grid gap-1">
              <CardTitle className="text-base">Deployments</CardTitle>
              <CardDescription>
                {live.length > 0
                  ? `${live.length} live · recent status mix`
                  : "Recent rollout status"}
              </CardDescription>
            </div>
            {can(user.role, "deployments.view") && <PanelLink href="/deployments">All</PanelLink>}
          </CardHeader>
          <CardContent className="grid gap-4">
            {deployStatusRows.length > 0 ? (
              <CountBars rows={deployStatusRows} ariaLabel="Deployments by status" />
            ) : (
              <RingStat
                value={0}
                total={1}
                label="No rollouts"
                hint="Nothing queued or running"
                tone="ok"
              />
            )}
            {live.length > 0 && (
              <ul className="grid gap-2 border-t pt-3 text-sm">
                {live.slice(0, 4).map((d) => (
                  <li key={d.id} className="flex items-start justify-between gap-3">
                    <Link href={`/deployments/${d.id}`} className="min-w-0 hover:underline">
                      {d.pluginName}{" "}
                      <span className="font-mono text-xs text-muted-foreground">{d.version}</span>
                      <span className="block text-xs text-muted-foreground">
                        {d.status.replaceAll("_", " ")} · {d.targets.length} targets
                      </span>
                    </Link>
                    <span className="text-xs whitespace-nowrap text-muted-foreground">
                      {timeAgo(d.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {waiting && (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div className="grid gap-1">
                <CardTitle className="text-base">Approvals</CardTitle>
                <CardDescription>Risky changes awaiting a second Admin</CardDescription>
              </div>
              <PanelLink href="/approvals">Open</PanelLink>
            </CardHeader>
            <CardContent className="grid gap-4">
              <RingStat
                value={waiting.length}
                total={Math.max(waiting.length, 5)}
                label="Waiting"
                hint={
                  waiting.length === 0
                    ? "Queue clear"
                    : `${waiting.length} request${waiting.length === 1 ? "" : "s"} to decide`
                }
                tone={waiting.length > 0 ? "warn" : "ok"}
              />
              {waiting.length > 0 && (
                <ul className="grid gap-2 border-t pt-3 text-sm">
                  {waiting.slice(0, 4).map((request) => (
                    <li key={request.id} className="flex items-start justify-between gap-3">
                      <span className="min-w-0 break-words">
                        {request.summary}
                        <span className="block text-xs text-muted-foreground">
                          {request.ownRequest ? "Your request" : request.requestedBy?.email}
                        </span>
                      </span>
                      <span className="text-xs whitespace-nowrap text-muted-foreground">
                        {timeAgo(request.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {admin && (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div className="grid gap-1">
                <CardTitle className="text-base">Security alerts</CardTitle>
                <CardDescription>Sign-ins, lockouts, role and host-key changes</CardDescription>
              </div>
              <PanelLink href="/notifications">Inbox</PanelLink>
            </CardHeader>
            <CardContent className="grid gap-4">
              {alertKindRows.length > 0 ? (
                <>
                  <CountBars rows={alertKindRows} ariaLabel="Security alerts by kind" />
                  <ul className="grid gap-2 border-t pt-3 text-sm">
                    {alertRows.slice(0, 4).map((alert) => (
                      <li key={alert.id} className="flex items-start justify-between gap-3">
                        <span>
                          {ALERT_LABELS[alert.kind] ?? alert.kind}
                          <span className="block text-xs text-muted-foreground">
                            {alert.user?.email ?? "unknown"} · {alert.ip ?? "no IP"}
                          </span>
                        </span>
                        <span
                          className="text-xs whitespace-nowrap text-muted-foreground"
                          title={formatUtc(alert.createdAt)}
                        >
                          {timeAgo(alert.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <RingStat
                  value={0}
                  total={1}
                  label="All quiet"
                  hint="No recent security alerts"
                  tone="ok"
                />
              )}
            </CardContent>
          </Card>
        )}

        {admin && (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div className="grid gap-1">
                <CardTitle className="text-base">Recent activity</CardTitle>
                <CardDescription>Audit log by category</CardDescription>
              </div>
              <PanelLink href="/audit">View all</PanelLink>
            </CardHeader>
            <CardContent className="grid gap-4">
              {activityCats.length > 0 ? (
                <>
                  <CountBars rows={activityCats} ariaLabel="Audit actions by category" />
                  <ul className="grid gap-2 border-t pt-3 text-sm">
                    {activityRows.slice(0, 5).map((entry) => (
                      <li key={entry.id} className="flex justify-between gap-3">
                        <span className="min-w-0 truncate">
                          <span className="font-mono text-xs">{entry.action}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            · {entry.user?.email ?? "system"}
                          </span>
                        </span>
                        <span
                          className="text-xs whitespace-nowrap text-muted-foreground"
                          title={formatUtc(entry.createdAt)}
                        >
                          {timeAgo(entry.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No recent audit entries.</p>
              )}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
