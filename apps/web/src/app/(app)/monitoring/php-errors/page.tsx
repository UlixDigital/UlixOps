// Monitoring → PHP errors (Phase 4 step 1, A159): every site's debug.log at a glance.
import { can, ErrorLogOverview, isClientViewer } from "@ulixops/shared";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { MonitoringTabs } from "../monitoring-tabs";
import { bulkLoggingAction } from "./actions";
import { PhpErrorsTable } from "./php-errors-table";

export const metadata: Metadata = { title: "PHP errors · UlixOps" };

export default async function PhpErrorsPage() {
  const { user } = await requireSession();
  const res = await apiGet("/monitoring/php-errors", ErrorLogOverview, await apiAuth(), {
    timeoutMs: 15_000,
  });
  const header = (
    <>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Monitoring</h1>
        <p className="text-sm text-muted-foreground">
          Each production site&apos;s PHP error log (UlixOps private log, or debug.log) is read
          every {res.ok ? res.data.everyHours : 6} hours over SSH (read-only). A new fatal error
          sends an alert. Open a site for its grouped messages and stack traces, or to read it now.
        </p>
      </div>
      <MonitoringTabs active="/monitoring/php-errors" showVisual={!isClientViewer(user.role)} />
    </>
  );
  if (!res.ok)
    return (
      <div className="grid gap-4">
        {header}
        <Notice tone="error">PHP errors couldn&apos;t be loaded. Refresh the page.</Notice>
      </div>
    );
  const { rows } = res.data;
  // Production sites whose wp-config.php says logging is off (read at least once).
  const off = rows.filter(
    (r) => r.environment === "PRODUCTION" && r.readAt && r.logging.state === "off",
  );
  const tiles = [
    { label: "Sites with fatal errors, 24 h", value: rows.filter((r) => r.fatal24h > 0).length },
    { label: "Fatal errors, 24 h", value: rows.reduce((n, r) => n + r.fatal24h, 0) },
    { label: "Warnings, 24 h", value: rows.reduce((n, r) => n + r.warnings24h, 0) },
    { label: "Sites with a log file", value: rows.filter((r) => r.fileFound).length },
  ];
  return (
    <div className="grid gap-4">
      {header}
      <section aria-label="PHP error summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{t.value}</p>
          </Card>
        ))}
      </section>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">Sites</CardTitle>
            <CardDescription>
              Sites with the most fatal errors first. A site without a log file needs Switch logging
              on (UlixOps mu-plugin) before PHP errors appear here.
            </CardDescription>
          </div>
          {can(user.role, "sites.manage") && off.length > 0 && (
            <ActionForm
              action={bulkLoggingAction}
              submitLabel={`Switch logging on for ${off.length} site${off.length === 1 ? "" : "s"}`}
              variant="outline"
              confirm={{
                title: `Switch PHP error logging on for ${off.length} production site${off.length === 1 ? "" : "s"}?`,
                description: `${off
                  .map((r) => r.siteName)
                  .slice(0, 8)
                  .join(
                    ", ",
                  )}${off.length > 8 ? ` and ${off.length - 8} more` : ""}. Each gets the UlixOps must-use plugin writing to a private log (no wp-config edits); a site whose log can be downloaded is left off. Another Admin approves first (a Super Admin approves their own).`,
              }}
            >
              {off.map((r) => (
                <input
                  key={r.environmentId}
                  type="hidden"
                  name="environmentId"
                  value={r.environmentId}
                />
              ))}
            </ActionForm>
          )}
        </CardHeader>
        <CardContent>
          <PhpErrorsTable rows={rows} />
        </CardContent>
      </Card>
    </div>
  );
}
