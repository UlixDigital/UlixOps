// File integrity for one site's Security tab (A144): last result per environment, Check now.
import type { IntegrityCheckView } from "@ulixops/shared";
import Link from "next/link";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { startIntegrityCheckAction } from "@/app/(app)/security/integrity/actions";
import { ActionForm } from "@/components/action-form";
import { EnvBadge } from "@/components/env-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUtc, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export const INTEGRITY_STATUS: Record<
  IntegrityCheckView["status"],
  { label: string; tone: string }
> = {
  RUNNING: { label: "Checking…", tone: "bg-primary/10 text-primary" },
  CLEAN: { label: "Matches WordPress.org", tone: "bg-success/10 text-success" },
  CHANGED: { label: "Files changed", tone: "bg-destructive/10 text-destructive" },
  FAILED: { label: "Check failed", tone: "bg-warning/10 text-warning" },
};

export function IntegrityBadge({ status }: { status: IntegrityCheckView["status"] }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        INTEGRITY_STATUS[status].tone,
      )}
    >
      {INTEGRITY_STATUS[status].label}
    </span>
  );
}

export function IntegrityCard({
  siteId,
  checks,
  environments,
  canCheck,
}: {
  siteId: string;
  checks: IntegrityCheckView[];
  environments: ("PRODUCTION" | "STAGING")[];
  canCheck: boolean;
}) {
  const running = checks.some((c) => c.status === "RUNNING");
  return (
    <Card>
      {running && <LiveRefresh intervalMs={3_000} />}
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle className="text-base">File integrity</CardTitle>
          <CardDescription>
            WordPress core and WordPress.org plugins compared with the official files.{" "}
            <Link href="/security/integrity" className="text-link hover:underline">
              All sites
            </Link>
          </CardDescription>
        </div>
        {canCheck && (
          <div className="flex flex-wrap gap-2">
            {environments
              .filter(
                (kind) => !checks.some((c) => c.environment === kind && c.status === "RUNNING"),
              )
              .map((kind) => (
                <ActionForm
                  key={kind}
                  action={startIntegrityCheckAction}
                  submitLabel={
                    environments.length > 1 ? `Check ${kind.toLowerCase()}` : "Check now"
                  }
                  variant="outline"
                  pendingLabel="Starting…"
                >
                  <input type="hidden" name="siteId" value={siteId} />
                  <input type="hidden" name="kind" value={kind} />
                </ActionForm>
              ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {environments.map((kind) => {
          const last = checks.find((c) => c.environment === kind);
          return (
            <div key={kind} className="grid gap-1.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {environments.length > 1 && <EnvBadge kind={kind} />}
                {last ? (
                  <>
                    <IntegrityBadge status={last.status} />
                    {last.findingCount > 0 && (
                      <span className="text-xs text-destructive">
                        {last.findingCount} file{last.findingCount === 1 ? "" : "s"}
                      </span>
                    )}
                    <span className="text-muted-foreground" title={formatUtc(last.startedAt)}>
                      {timeAgo(last.finishedAt ?? last.startedAt)}
                    </span>
                    {last.status !== "RUNNING" && (
                      <Link
                        href={`/security/integrity/${last.id}`}
                        className="text-link hover:underline"
                      >
                        Details
                      </Link>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">Not checked yet.</span>
                )}
              </div>
              {last?.detail && last.status !== "RUNNING" && (
                <p className="text-xs text-muted-foreground">{last.detail}</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
