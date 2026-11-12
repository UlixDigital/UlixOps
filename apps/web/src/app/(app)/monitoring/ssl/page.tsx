// Monitoring → SSL & domains (Phase 3 step 1, A148): every site's certificate and every
// domain's registration, soonest expiry first.
import { can, ExpiryOverview, isClientViewer } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { EnvBadge } from "@/components/env-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { MonitoringTabs } from "../monitoring-tabs";
import { CertificatesTable } from "./certificates-table";
import { DomainsTable } from "./domains-table";

export const metadata: Metadata = { title: "SSL & domains · UlixOps" };

export default async function SslDomainsPage() {
  const { user } = await requireSession();
  const res = await apiGet("/monitoring/expiry", ExpiryOverview, await apiAuth(), {
    timeoutMs: 15_000,
  });
  const header = (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Monitoring</h1>
        <p className="text-sm text-muted-foreground">
          SSL certificates and domain registrations, checked daily. Alerts go out 30, 14, 7, 3 and 1
          days before anything expires. Nothing is changed on the sites.
        </p>
      </div>
      <MonitoringTabs active="/monitoring/ssl" showVisual={!isClientViewer(user.role)} />
    </>
  );
  if (!res.ok)
    return (
      <div className="grid gap-4">
        {header}
        <Notice tone="error">
          SSL and domain status couldn&apos;t be loaded. Refresh the page.
        </Notice>
      </div>
    );
  const { certificates, domains, unchecked, status } = res.data;
  const https = certificates.filter((c) => c.https);
  const problems = https.filter((c) => !c.ok && (c.daysLeft === null || c.daysLeft >= 0)).length;
  const soon = (d: number | null) => d !== null && d <= 30;
  const tiles = [
    {
      label: "Certificate problems",
      value: problems,
      tone: problems ? "text-destructive" : "",
    },
    {
      label: "Certificates expiring ≤ 30 days",
      value: https.filter((c) => soon(c.daysLeft)).length,
      tone: https.some((c) => soon(c.daysLeft)) ? "text-warning" : "",
    },
    {
      label: "Domains expiring ≤ 30 days",
      value: domains.filter((d) => soon(d.daysLeft)).length,
      tone: domains.some((d) => soon(d.daysLeft)) ? "text-warning" : "",
    },
    {
      label: "Domains without a date",
      value: domains.filter((d) => !d.expiresAt).length,
      tone: "",
    },
  ];

  return (
    <div className="grid gap-4">
      {status.running && <LiveRefresh intervalMs={3_000} />}
      {header}
      {status.ok === false && (
        <Notice tone="error">
          The last daily check failed ({status.error ?? "unknown error"}). It retries within 6
          hours.
        </Notice>
      )}
      <section
        aria-label="SSL and domain summary"
        className="grid grid-cols-2 gap-3 md:grid-cols-5"
      >
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className={cn("mt-1 text-2xl font-semibold tracking-tight", t.tone)}>{t.value}</p>
          </Card>
        ))}
        <Card className="col-span-2 p-4 md:col-span-1">
          <p className="text-xs text-muted-foreground">Last daily check</p>
          <p className="mt-1 text-sm font-medium" title={formatUtc(status.lastSuccessAt)}>
            {status.running
              ? "Checking now…"
              : status.lastSuccessAt
                ? timeAgo(status.lastSuccessAt)
                : "Not yet"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">Every site, once a day</p>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">SSL certificates</CardTitle>
          <CardDescription>
            Read with a TLS handshake, the way a browser would. Problems (untrusted, wrong name,
            unreachable) first, then the soonest to expire.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CertificatesTable rows={certificates} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Domains</CardTitle>
          <CardDescription>
            Production domains, from the registry&apos;s public RDAP service. Some country domains
            (for example .de) publish no expiry date
            {can(user.role, "settings.manage")
              ? ": enter it from the registrar and alerts work the same."
              : "; an Admin can enter it from the registrar."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DomainsTable rows={domains} canManage={can(user.role, "settings.manage")} />
        </CardContent>
      </Card>

      {unchecked.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not checked</CardTitle>
            <CardDescription>
              Sites without a public address (local test containers), or added since the last daily
              check. Open a site&apos;s Uptime &amp; SSL tab to check it now.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1.5 text-sm">
              {unchecked.map((u) => (
                <li
                  key={`${u.siteId}-${u.environment}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Link
                    href={`/sites/${u.siteId}/monitoring`}
                    className="font-medium hover:underline"
                  >
                    {u.siteName}
                  </Link>
                  {u.environment === "STAGING" && <EnvBadge kind="STAGING" />}
                  <span className="text-xs break-all text-muted-foreground">{u.url}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
