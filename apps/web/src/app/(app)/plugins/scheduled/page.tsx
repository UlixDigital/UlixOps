// Plugins → Scheduled updates (Phase 4 step 2, A162): every site's weekly update window.
import { AutoUpdateOverview, can } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { AutoUpdateOverviewTable } from "./overview-table";

export const metadata: Metadata = { title: "Scheduled updates · UlixOps" };

export default async function ScheduledUpdatesPage() {
  const { user } = await requireSession();
  if (!can(user.role, "sites.view")) return <NoAccess role={user.role} what="scheduled updates" />;
  const res = await apiGet("/auto-updates", AutoUpdateOverview, await apiAuth());
  const rows = res.ok ? res.data.rows : [];
  const on = rows.filter((r) => r.enabled).length;
  const problems = rows.filter((r) => r.lastRun?.status === "problems").length;
  const tiles = [
    { label: "Sites with scheduled updates", value: `${on} of ${rows.length}` },
    { label: "Last run had problems", value: problems },
    { label: "Held versions", value: rows.reduce((n, r) => n + r.holds, 0) },
  ];

  return (
    <div className="grid gap-4">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/plugins" className="hover:underline">
            Plugins
          </Link>{" "}
          /
        </p>
        <h1 className="text-xl font-semibold tracking-tight">Scheduled updates</h1>
        <p className="text-sm text-muted-foreground">
          Once a week, in each site&apos;s window: patch and minor plugin and theme updates and
          WordPress maintenance releases install unattended, staging first where there is one. Each
          item gets a quick snapshot, a health check and a rollback; the first problem stops the
          run. Major versions are only listed. Off by default; switching on needs a second Admin.
        </p>
      </div>
      {!res.ok ? (
        <Notice tone="error">Scheduled updates couldn&apos;t be loaded. Refresh the page.</Notice>
      ) : (
        <>
          <section
            aria-label="Scheduled updates summary"
            className="grid grid-cols-1 gap-3 sm:grid-cols-3"
          >
            {tiles.map((t) => (
              <Card key={t.label} className="p-4">
                <p className="text-xs text-muted-foreground">{t.label}</p>
                <p className="mt-1 text-2xl font-semibold tracking-tight">{t.value}</p>
              </Card>
            ))}
          </section>
          {res.data.running && (
            <Notice>
              Scheduled updates are running now. Results appear here when they finish.
            </Notice>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sites</CardTitle>
              <CardDescription>
                Open a site&apos;s Plugins &amp; themes tab to change its window, skip list or held
                versions, and to see each run&apos;s report.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No sites yet.</p>
              ) : (
                <AutoUpdateOverviewTable rows={rows} canManage={can(user.role, "sites.manage")} />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
