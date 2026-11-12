// DNS (spec screen 15, Phase 3 step 3, A156): every Cloudflare domain the token can see, with
// its status, linked site and changes made outside UlixOps.
import { can, DnsOverview } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { syncAllAction } from "./actions";
import { ZonesTable } from "./zones-table";

export const metadata: Metadata = { title: "DNS · UlixOps" };

export default async function DnsPage() {
  const { user } = await requireSession();
  const res = await apiGet("/dns", DnsOverview, await apiAuth(), { timeoutMs: 15_000 });
  const header = (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">DNS</h1>
      <p className="text-sm text-muted-foreground">
        Cloudflare domains and their records. Every domain is read again every 6 hours: changes made
        outside UlixOps send an alert. A snapshot is taken before and after every change made here,
        and any snapshot can be rolled back (another Admin approves).
      </p>
    </div>
  );
  if (!res.ok)
    return (
      <div className="grid gap-4">
        {header}
        <Notice tone="error">DNS couldn&apos;t be loaded. Refresh the page.</Notice>
      </div>
    );
  const { zones, status, tokenSet } = res.data;
  const canRefresh = can(user.role, "sites.refresh");
  const outside = zones.reduce((n, z) => n + z.externalChanges7d, 0);

  return (
    <div className="grid gap-4">
      <LiveRefresh intervalMs={status.running ? 3_000 : 60_000} />
      {header}
      {!tokenSet && (
        <Notice>
          No Cloudflare API token yet. An Admin adds it in{" "}
          <Link href="/settings/credentials" className="text-link hover:underline">
            Settings → Credentials
          </Link>{" "}
          (the card explains exactly how to create it). Then come back and refresh.
        </Notice>
      )}
      {tokenSet && status.ok === false && (
        <Notice tone="error">Last refresh: {status.error ?? "failed"}</Notice>
      )}
      <section aria-label="DNS summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Domains", value: String(zones.filter((z) => !z.removed).length) },
          {
            label: "Not active yet",
            value: String(zones.filter((z) => !z.removed && z.status !== "active").length),
          },
          { label: "Outside changes, 7 days", value: String(outside) },
        ].map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{t.value}</p>
          </Card>
        ))}
        <Card className="col-span-2 p-4 md:col-span-1">
          <p className="text-xs text-muted-foreground">Last read from Cloudflare</p>
          <p className="mt-1 text-sm font-medium" title={formatUtc(status.lastRunAt)}>
            {status.running
              ? "Reading now…"
              : status.lastRunAt
                ? timeAgo(status.lastRunAt)
                : "Not yet"}
          </p>
          {canRefresh && !status.running && (
            <ActionForm
              action={syncAllAction}
              submitLabel="Refresh now"
              variant="outline"
              className="mt-2"
            />
          )}
        </Card>
      </section>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Domains</CardTitle>
          <CardDescription>
            Domains with outside changes first. A domain is linked to the site whose production URL
            is in it. &quot;No access&quot; means the token can no longer see it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ZonesTable zones={zones} />
        </CardContent>
      </Card>
    </div>
  );
}
