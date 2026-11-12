// Scheduled updates (A162): run status badge and a run's report, per environment.
import type { AutoUpdateRunStatus, AutoUpdateRunView } from "@ulixops/shared";
import { formatUtc, timeAgo } from "@/lib/format";
import { OUTCOME, RUN_STATUS } from "@/lib/autoupdates";
import { ENV_LABELS } from "@/lib/site-status";
import { cn } from "@/lib/utils";

export function RunBadge({ status }: { status: AutoUpdateRunStatus }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        RUN_STATUS[status].tone,
      )}
    >
      {RUN_STATUS[status].label}
    </span>
  );
}

export function RunReport({ run }: { run: AutoUpdateRunView }) {
  return (
    <details className="rounded-md border px-3 py-2 text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <span title={formatUtc(run.startedAt)}>{timeAgo(run.startedAt)}</span>
        <RunBadge status={run.status} />
        <span className="text-xs text-muted-foreground">
          {run.updated} updated
          {run.problems > 0 && ` · ${run.problems} problem${run.problems === 1 ? "" : "s"}`}
        </span>
      </summary>
      <div className="mt-3 grid gap-3">
        {run.environments.map((env) => (
          <div key={env.kind} className="grid gap-1">
            <p className="font-medium">
              {ENV_LABELS[env.kind]}
              <span className="ml-2 font-normal text-muted-foreground">{env.detail}</span>
            </p>
            {env.items.length > 0 && (
              <ul className="grid gap-1">
                {env.items.map((i) => (
                  <li
                    key={`${i.asset}:${i.name}`}
                    className="grid gap-0.5 sm:grid-cols-[minmax(0,14rem)_8rem_minmax(0,1fr)] sm:gap-3"
                  >
                    <span className="truncate font-mono text-xs" title={i.name}>
                      {i.asset === "core" ? "WordPress" : i.name} {i.version} → {i.updateVersion}
                    </span>
                    <span className={cn("text-xs font-medium", OUTCOME[i.outcome].tone)}>
                      {OUTCOME[i.outcome].label}
                    </span>
                    <span className="text-xs break-words text-muted-foreground">{i.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {run.manual.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Waiting for a manual update (major versions):{" "}
            {run.manual
              .map((m) => `${m.asset === "core" ? "WordPress" : m.name} ${m.updateVersion}`)
              .join(", ")}
          </p>
        )}
      </div>
    </details>
  );
}
