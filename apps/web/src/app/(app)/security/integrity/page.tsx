// Security → File integrity (Phase 2 step 4, A144): every site's last check against the
// official WordPress.org files.
import { can, IntegrityOverview } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SecurityTabs } from "../security-tabs";
import { IntegritySitesTable } from "./sites-table";

export const metadata: Metadata = { title: "File integrity · UlixOps" };

export default async function IntegrityPage() {
  const { user } = await requireSession();
  const res = await apiGet("/integrity-checks/overview", IntegrityOverview, await apiAuth(), {
    timeoutMs: 15_000,
  });
  const header = (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Security</h1>
        <p className="text-sm text-muted-foreground">
          File integrity compares each site&apos;s WordPress core and WordPress.org plugins with the
          official files, to catch modified or injected code. Nothing is changed on the sites.
        </p>
      </div>
      <SecurityTabs active="/security/integrity" />
    </>
  );
  if (!res.ok)
    return (
      <div className="grid gap-4">
        {header}
        <Notice tone="error">File integrity couldn&apos;t be loaded. Refresh the page.</Notice>
      </div>
    );
  const { sites, stats, automatic } = res.data;
  const tiles = [
    { label: "Files changed", value: stats.changed, tone: stats.changed ? "text-destructive" : "" },
    { label: "Matches WordPress.org", value: stats.clean, tone: "" },
    { label: "Check failed", value: stats.failed, tone: stats.failed ? "text-warning" : "" },
    { label: "Not checked yet", value: stats.neverChecked, tone: "" },
  ];
  return (
    <div className="grid gap-4">
      {sites.some((s) => s.running) && <LiveRefresh intervalMs={3_000} />}
      {header}
      <section aria-label="Integrity summary" className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className={cn("mt-1 text-2xl font-semibold tracking-tight", t.tone)}>{t.value}</p>
          </Card>
        ))}
        <Card className="col-span-2 p-4 md:col-span-1">
          <p className="text-xs text-muted-foreground">Last check finished</p>
          <p className="mt-1 text-sm font-medium" title={formatUtc(stats.lastFinishedAt)}>
            {stats.lastFinishedAt ? timeAgo(stats.lastFinishedAt) : "—"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {automatic ? "Each site daily, one at a time" : "Automatic checks are off"}
          </p>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sites</CardTitle>
          <CardDescription>
            {automatic
              ? "Checked once a day per site, in the window set under "
              : "Daily checks are off; turn them on under "}
            <Link href="/security/malware" className="text-link hover:underline">
              Malware scans → Schedule
            </Link>
            . Changed sites first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <IntegritySitesTable rows={sites} canCheck={can(user.role, "sites.refresh")} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What is checked</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid list-disc gap-1.5 pl-5 text-sm">
            <li>
              <span className="font-medium">WordPress core:</span> every file in wp-admin and
              wp-includes plus the root files, against the release the site runs. Extra PHP files
              there are flagged too (a common hiding place for backdoors). Works even when the site
              is broken.
            </li>
            <li>
              <span className="font-medium">Plugins from WordPress.org:</span> changed, added and
              missing files.
            </li>
            <li>
              <span className="font-medium">Not covered:</span> premium and custom plugins (no
              public checksums: listed as &quot;not verifiable&quot;), themes and uploads. The
              malware scan covers those.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
