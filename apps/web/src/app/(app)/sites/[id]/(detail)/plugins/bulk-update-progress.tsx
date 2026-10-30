import type { BulkUpdateStatusResponse, VersionJumpSafety } from "@ulixops/shared";
import Link from "next/link";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";

const SAFETY_LABEL: Record<VersionJumpSafety, string> = {
  patch: "Patch",
  minor: "Minor",
  major: "Major",
  unknown: "Unknown",
};

const STEP_LABEL = {
  snapshot: "Snapshot",
  update: "Update",
  health: "Health check",
  rollback: "Rollback",
} as const;

export function BulkUpdateProgress({
  status,
  siteId,
  envQuery,
}: {
  status: BulkUpdateStatusResponse;
  siteId: string;
  envQuery: string;
}) {
  if (!status.runStatus) return null;

  if (status.runStatus === "pending_approval") {
    return (
      <Notice>
        Bulk update is waiting for another Admin on{" "}
        <Link href="/approvals" className="underline">
          Approvals
        </Link>
        . The update button stays available for a different set of items if inventory changes.
      </Notice>
    );
  }

  const progress = status.progress;
  const live = status.active;
  const report = status.reportMarkdown ?? progress?.reportMarkdown ?? null;

  return (
    <div className="grid gap-3 rounded-md border p-4">
      {live && <LiveRefresh intervalMs={2_000} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {live ? "Bulk update in progress" : "Bulk update report"}
        </h2>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {status.runStatus.replaceAll("_", " ")}
        </span>
      </div>

      {progress?.preHealth && (
        <p className="text-sm">
          Pre-update health:{" "}
          <span className={progress.preHealth.ok ? "text-success" : "text-destructive"}>
            {progress.preHealth.ok ? "OK" : "FAILED"}
          </span>
          <span className="text-muted-foreground"> — {progress.preHealth.summary}</span>
        </p>
      )}

      {progress?.current && live && (
        <p className="text-sm font-medium">
          Now: {progress.current.asset}{" "}
          <span className="font-mono text-xs">{progress.current.name}</span> ·{" "}
          {STEP_LABEL[progress.current.step]} ({progress.current.index + 1}/{progress.current.total}
          )
        </p>
      )}

      {progress && progress.items.length > 0 && (
        <ul className="grid gap-2">
          {progress.items.map((item) => {
            const active =
              progress.current?.name === item.name && progress.current?.asset === item.asset;
            return (
              <li
                key={`${item.asset}:${item.name}`}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm",
                  active && "border-foreground/40",
                )}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="capitalize text-muted-foreground">{item.asset}</span>{" "}
                    <span className="font-mono text-xs">{item.name}</span>{" "}
                    <span className="text-muted-foreground">
                      {item.version} → {item.updateVersion}
                    </span>{" "}
                    <span className="text-xs text-muted-foreground">
                      ({SAFETY_LABEL[item.safety]})
                    </span>
                  </span>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    {item.outcome}
                  </span>
                </div>
                {item.steps.length > 0 && (
                  <ol className="mt-2 grid gap-1 text-xs text-muted-foreground">
                    {item.steps.map((step, i) => (
                      <li key={`${step.step}-${i}`}>
                        <span className={step.ok ? "text-success" : "text-destructive"}>
                          {STEP_LABEL[step.step]}
                        </span>
                        {": "}
                        <span className="break-words whitespace-pre-wrap">{step.detail}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {report && !live && (
        <details className="rounded-md border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">Full report</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
            {report}
          </pre>
        </details>
      )}

      {!live && status.runStatus === "failed" && (
        <Notice tone="error">
          Some items failed or were rolled back. Open the report above, or retry from{" "}
          <Link href={`/sites/${siteId}/plugins?env=${envQuery}`} className="underline">
            this page
          </Link>{" "}
          after refreshing inventory.
        </Notice>
      )}
    </div>
  );
}
