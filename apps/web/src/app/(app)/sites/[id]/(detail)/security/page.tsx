// Spec screen 5, Security tab (Phase 2 step 2): this site's vulnerability findings.
import { can, IntegrityCheckList, MalwareScanList, VulnFindingList } from "@ulixops/shared";
import type { Metadata } from "next";
import { FeedStatusLine } from "@/app/(app)/security/feed-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { IntegrityCard } from "@/components/integrity-card";
import { MalwareScanCard } from "@/components/malware-scan-card";
import { VulnTable } from "@/components/vuln-table";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { loadSite } from "@/lib/site";

export const metadata: Metadata = { title: "Security · UlixOps" };

export default async function SiteSecurityPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireSession();
  const site = await loadSite((await params).id);
  const auth = await apiAuth();
  const [res, scans, checks] = await Promise.all([
    apiGet(`/sites/${site.id}/vulnerabilities`, VulnFindingList, auth),
    apiGet(`/sites/${site.id}/malware-scans`, MalwareScanList, auth),
    apiGet(`/sites/${site.id}/integrity-checks`, IntegrityCheckList, auth),
  ]);
  if (!res.ok)
    return <Notice tone="error">Vulnerabilities couldn&apos;t be loaded. Refresh the page.</Notice>;

  const open = res.data.findings.filter((f) => f.resolvedAt === null);
  const resolved = res.data.findings.filter((f) => f.resolvedAt !== null);

  return (
    <div className="grid gap-4">
      {scans.ok ? (
        <MalwareScanCard
          siteId={site.id}
          scans={scans.data.scans}
          environments={site.environments.map((e) => e.kind)}
          canScan={can(user.role, "sites.refresh") && !site.archived}
        />
      ) : (
        <Notice tone="error">Malware scans couldn&apos;t be loaded. Refresh the page.</Notice>
      )}
      {checks.ok ? (
        <IntegrityCard
          siteId={site.id}
          checks={checks.data.checks}
          environments={site.environments.map((e) => e.kind)}
          canCheck={can(user.role, "sites.refresh") && !site.archived}
        />
      ) : (
        <Notice tone="error">File integrity couldn&apos;t be loaded. Refresh the page.</Notice>
      )}
      <FeedStatusLine feed={res.data.feed} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open vulnerabilities</CardTitle>
          <CardDescription>
            Matched against each environment&apos;s last inventory. After updating, refresh the
            inventory and the finding resolves on its own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VulnTable
            findings={open}
            showSite={false}
            emptyText="No known vulnerabilities in the versions this site runs."
          />
        </CardContent>
      </Card>
      {resolved.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resolved in the last 90 days</CardTitle>
          </CardHeader>
          <CardContent>
            <VulnTable findings={resolved} showSite={false} emptyText="Nothing resolved." />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
