// Security (Phase 2 step 2): known vulnerabilities in the core, plugin and theme versions our
// sites run, from the Wordfence Intelligence feed (A132).
import { can, MalwareScanList, VulnFindingList } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { EnvBadge } from "@/components/env-badge";
import { ScanStatusBadge } from "@/components/malware-scan-card";
import { VulnTable } from "@/components/vuln-table";
import { formatUtc, timeAgo } from "@/lib/format";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { SEVERITY } from "@/lib/site-status";
import { cn } from "@/lib/utils";
import { FeedStatusLine } from "./feed-status";
import { SecurityTabs } from "./security-tabs";
import { SyncButton } from "./sync-button";

export const metadata: Metadata = { title: "Security · UlixOps" };

const COUNT_TONE = {
  critical: "text-destructive",
  high: "text-destructive",
  medium: "text-warning",
  low: "",
} as const;

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const resolved = (await searchParams).status === "resolved";
  const auth = await apiAuth();
  const [res, scansRes] = await Promise.all([
    apiGet(`/vulnerabilities${resolved ? "?status=resolved" : ""}`, VulnFindingList, auth),
    apiGet("/malware-scans/latest", MalwareScanList, auth),
  ]);
  const ORDER = ["INFECTED", "FAILED", "RUNNING", "CLEAN"];
  const scans = scansRes.ok
    ? [...scansRes.data.scans].sort(
        (a, b) =>
          ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.siteName.localeCompare(b.siteName),
      )
    : null;

  const findings = res.ok ? res.data.findings : [];
  const infected = (scans ?? []).filter((s) => s.status === "INFECTED");
  const counts = (["critical", "high", "medium", "low"] as const).map((level) => ({
    level,
    count: findings.filter((f) => f.severity === level).length,
  }));
  const sites = new Set(findings.map((f) => f.siteId)).size;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Security</h1>
          <p className="text-sm text-muted-foreground">
            Known vulnerabilities in the WordPress, plugin and theme versions our sites run, from
            the Wordfence Intelligence feed.
          </p>
        </div>
        {can(user.role, "vulns.sync") && res.ok && !res.data.feed.running && <SyncButton />}
      </div>
      <SecurityTabs active="/security" />

      {!res.ok ? (
        <Notice tone="error">Vulnerabilities couldn&apos;t be loaded. Refresh the page.</Notice>
      ) : (
        <FeedStatusLine feed={res.data.feed} />
      )}

      {!resolved && res.ok && (
        <section aria-label="Open by severity" className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {counts.map(({ level, count }) => (
            <Card key={level} className="p-4">
              <p className="text-xs text-muted-foreground">{SEVERITY[level].label}</p>
              <p
                className={cn(
                  "mt-1 text-2xl font-semibold tracking-tight",
                  count > 0 && COUNT_TONE[level],
                )}
              >
                {count}
              </p>
            </Card>
          ))}
        </section>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">Malware scans</CardTitle>
            <CardDescription>
              {!scans
                ? "Malware scans couldn't be loaded."
                : scans.length === 0
                  ? "No scans yet."
                  : `${infected.length} site${infected.length === 1 ? "" : "s"} with malware found, ${scans.filter((s) => s.status === "CLEAN").length} clean, ${scans.filter((s) => s.status === "RUNNING" || s.status === "QUEUED").length} scanning or queued.`}
            </CardDescription>
          </div>
          <Link href="/security/malware" className="text-sm text-link hover:underline">
            Open malware scans
          </Link>
        </CardHeader>
        {infected.length > 0 && (
          <CardContent>
            <ul className="divide-y rounded-md border text-sm">
              {infected.map((scan) => (
                <li
                  key={scan.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/security/malware/${scan.id}`}
                      className="font-medium hover:underline"
                    >
                      {scan.siteName}
                    </Link>
                    {scan.environment === "STAGING" && <EnvBadge kind="STAGING" />}
                    <ScanStatusBadge status={scan.status} />
                    <span className="text-xs text-destructive">
                      {scan.findingCount} file{scan.findingCount === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground" title={formatUtc(scan.startedAt)}>
                    {timeAgo(scan.startedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">
              {resolved ? "Resolved in the last 90 days" : "Open vulnerabilities"}
            </CardTitle>
            <CardDescription>
              {resolved
                ? "Findings that went away after an update or removal."
                : `${findings.length} on ${sites} site${sites === 1 ? "" : "s"}. Update to the "fixed in" version, or deactivate the software if there is no fix yet.`}
            </CardDescription>
          </div>
          <nav aria-label="Finding status" className="flex gap-1 text-sm">
            <Link
              href="/security"
              aria-current={resolved ? undefined : "page"}
              className={cn(
                "rounded-md px-2.5 py-1.5",
                resolved ? "text-muted-foreground hover:text-foreground" : "bg-accent font-medium",
              )}
            >
              Open
            </Link>
            <Link
              href="/security?status=resolved"
              aria-current={resolved ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1.5",
                resolved ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Resolved
            </Link>
          </nav>
        </CardHeader>
        <CardContent>
          <VulnTable
            findings={findings}
            emptyText={
              resolved
                ? "Nothing resolved in the last 90 days."
                : "No known vulnerabilities in the versions our sites run. Findings use each site's last inventory, so refresh inventories after updates."
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
