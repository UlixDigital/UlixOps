// Spec screen 5, Uptime & SSL tab [P3]: this site's uptime (P3-2, A149), certificates and
// domain (P3-1, A148).
import { can, SiteExpiryView, SiteUptimeView } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { checkSiteExpiryAction } from "@/app/(app)/monitoring/actions";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { ActionForm } from "@/components/action-form";
import { DomainExpiryForm } from "@/components/domain-expiry-form";
import { EnvBadge } from "@/components/env-badge";
import { dateOnly, daysText, ExpiryBadge } from "@/components/expiry-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { loadSite } from "@/lib/site";
import { UptimeCard } from "./uptime-card";

export const metadata: Metadata = { title: "Uptime & SSL · UlixOps" };

export default async function SiteMonitoringPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireSession();
  const site = await loadSite((await params).id);
  const auth = await apiAuth();
  const [res, uptime] = await Promise.all([
    apiGet(`/sites/${site.id}/expiry`, SiteExpiryView, auth),
    apiGet(`/sites/${site.id}/uptime`, SiteUptimeView, auth),
  ]);
  const canCheck = can(user.role, "sites.refresh") && !site.archived;
  const canManage = can(user.role, "settings.manage");
  const uptimeCard = (
    <UptimeCard
      siteId={site.id}
      data={uptime.ok ? uptime.data : null}
      canCheck={canCheck}
      canManage={canManage}
    />
  );
  if (!res.ok)
    return (
      <div className="grid gap-4">
        {uptime.ok && uptime.data.status.running && <LiveRefresh intervalMs={3_000} />}
        {uptimeCard}
        <Notice tone="error">
          SSL and domain status couldn&apos;t be loaded. Refresh the page.
        </Notice>
      </div>
    );
  const { certificates, domains, status } = res.data;

  return (
    <div className="grid gap-4">
      {(status.running || (uptime.ok && uptime.data.status.running)) && (
        <LiveRefresh intervalMs={3_000} />
      )}
      {uptimeCard}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">SSL certificate</CardTitle>
            <CardDescription>
              Checked daily with a TLS handshake. Alerts 30, 14, 7, 3 and 1 days before it expires,
              and at once when browsers wouldn&apos;t trust it.{" "}
              <Link href="/monitoring/ssl" className="text-link hover:underline">
                All sites
              </Link>
            </CardDescription>
          </div>
          {canCheck && !status.running && (
            <ActionForm
              action={checkSiteExpiryAction}
              submitLabel="Check now"
              variant="outline"
              pendingLabel="Starting…"
            >
              <input type="hidden" name="siteId" value={site.id} />
            </ActionForm>
          )}
        </CardHeader>
        <CardContent className="grid gap-4">
          {status.running && <p className="text-sm text-muted-foreground">Checking now…</p>}
          {site.environments.map((env) => {
            const c = certificates.find((x) => x.environment === env.kind);
            return (
              <div key={env.kind} className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {site.environments.length > 1 && <EnvBadge kind={env.kind} />}
                  {!c ? (
                    <span className="text-muted-foreground">
                      Not checked yet
                      {/^https?:\/\/(localhost|127\.|test-wp)/.test(env.url) &&
                        " (local test address: no public certificate)"}
                      .
                    </span>
                  ) : !c.https ? (
                    <>
                      <ExpiryBadge days={null} label="Plain http" />
                      <span className="text-muted-foreground">{c.host}</span>
                    </>
                  ) : (
                    <>
                      <ExpiryBadge days={c.daysLeft} problem={!c.ok} />
                      <span className="font-medium break-all">{c.host}</span>
                      <span className="text-muted-foreground" title={formatUtc(c.checkedAt)}>
                        checked {timeAgo(c.checkedAt)}
                      </span>
                    </>
                  )}
                </div>
                {c?.error && <p className="text-xs text-destructive">{c.error}</p>}
                {c?.https && c.validTo && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Valid</dt>
                    <dd>
                      {dateOnly(c.validFrom)} → {dateOnly(c.validTo)}
                      {c.daysLeft !== null && ` (${daysText(c.daysLeft)})`}
                    </dd>
                    <dt className="text-muted-foreground">Issuer</dt>
                    <dd>{c.issuer ?? "—"}</dd>
                    {c.altNames.length > 0 && (
                      <>
                        <dt className="text-muted-foreground">Covers</dt>
                        <dd className="break-all">
                          {c.altNames.slice(0, 8).join(", ")}
                          {c.altNames.length > 8 && ` and ${c.altNames.length - 8} more`}
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Domain registration</CardTitle>
          <CardDescription>
            The production domain&apos;s expiry, from the registry. If it lapses, the site and its
            email stop working.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Not checked yet, or the production address is a hosting provider&apos;s name (for
              example *.wpengine.com), whose registration isn&apos;t yours to renew.
            </p>
          ) : (
            domains.map((d) => (
              <div key={d.domain} className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium break-all">{d.domain}</span>
                  <ExpiryBadge
                    days={d.daysLeft}
                    label={d.daysLeft === null ? "No expiry date" : undefined}
                  />
                  {d.expiresAt && (
                    <span className="text-muted-foreground">
                      expires {dateOnly(d.expiresAt)}
                      {d.manual && " (entered by hand)"}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {d.registrar ? `Registrar: ${d.registrar}. ` : ""}
                  {d.checkedAt ? `Checked ${timeAgo(d.checkedAt)}.` : ""}
                </p>
                {d.error && (
                  <p
                    className={
                      d.status === "error"
                        ? "text-xs text-warning"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {d.error}
                  </p>
                )}
                {canManage && (d.status !== "found" || d.manual) && (
                  <div className="max-w-xs">
                    <DomainExpiryForm domain={d} siteId={site.id} />
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
