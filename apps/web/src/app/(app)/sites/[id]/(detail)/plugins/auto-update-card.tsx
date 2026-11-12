// Scheduled updates for one site (A162): status, window, skip list, holds and recent runs.
import { AutoUpdateView, type AutoUpdateSkip, PluginName } from "@ulixops/shared";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { RunBadge, RunReport } from "@/components/auto-update-parts";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { windowLabel } from "@/lib/autoupdates";
import { formatUtc } from "@/lib/format";
import {
  clearHoldAction,
  disableAutoUpdatesAction,
  enableAutoUpdatesAction,
} from "../../../../plugins/scheduled/actions";
import { AutoUpdateSettingsForm } from "../../../../plugins/scheduled/settings-form";

export async function AutoUpdateCard({
  siteId,
  siteName,
  installed,
  canManage,
}: {
  siteId: string;
  siteName: string;
  installed: AutoUpdateSkip[];
  canManage: boolean;
}) {
  const res = await apiGet(`/sites/${siteId}/auto-updates`, AutoUpdateView, await apiAuth());
  if (!res.ok)
    return (
      <Notice tone="error">Scheduled updates couldn&apos;t be loaded. Refresh the page.</Notice>
    );
  const v = res.data;
  const last = v.runs[0];
  const status = v.enabled
    ? `On · next run ${formatUtc(v.nextWindowAt)}`
    : v.pendingApprovalId
      ? "Waiting for another Admin to approve switching on"
      : "Off";

  return (
    <details className="group rounded-lg border bg-card text-card-foreground shadow-sm open:[&>summary_.chevron]:rotate-90">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-6 py-4 text-base font-semibold leading-none [&::-webkit-details-marker]:hidden">
        <span className="chevron text-muted-foreground transition-transform duration-150 select-none">
          ▸
        </span>
        Scheduled updates
        <span className="font-normal text-muted-foreground">· {status}</span>
        {last && <RunBadge status={last.status} />}
      </summary>
      <div className="grid gap-3 border-t px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-prose text-sm text-muted-foreground">
            Every {windowLabel(v.window)}: patch and minor plugin and theme updates and WordPress
            maintenance releases,{" "}
            {v.hasStaging ? "staging first, then production" : "on production"}, each with a
            snapshot, a health check and a rollback. Majors are only listed.{" "}
            <Link href="/plugins/scheduled" className="text-link hover:underline">
              All sites
            </Link>
          </p>
          {canManage &&
            (v.enabled ? (
              <ActionForm
                action={disableAutoUpdatesAction}
                submitLabel="Switch off"
                variant="outline"
              >
                <input type="hidden" name="siteId" value={siteId} />
              </ActionForm>
            ) : (
              !v.pendingApprovalId && (
                <ActionForm
                  action={enableAutoUpdatesAction}
                  submitLabel="Switch on"
                  confirm={{
                    title: `Switch scheduled updates on for ${siteName}?`,
                    description: `Every ${windowLabel(v.window)}, patch and minor updates install without anyone watching${v.hasStaging ? " (staging first; production only gets what staging ran healthily)" : ""}. Each item gets a snapshot, a health check and a rollback; the first problem stops the run and sends an alert. Another Admin approves first (a Super Admin approves their own).`,
                  }}
                >
                  <input type="hidden" name="siteId" value={siteId} />
                  <input type="hidden" name="dayOfWeek" value={v.window.dayOfWeek} />
                  <input type="hidden" name="hourUtc" value={v.window.hourUtc} />
                </ActionForm>
              )
            ))}
        </div>
        {!v.hasStaging && (
          <p className="text-xs text-muted-foreground">
            This site has no staging environment, so updates are tested only by the health check on
            production.
          </p>
        )}
        {v.holds.length > 0 && (
          <div className="grid gap-2">
            <p className="text-sm font-medium">Held versions</p>
            <ul className="divide-y rounded-md border text-sm">
              {v.holds.map((h) => (
                <li
                  key={`${h.asset}:${h.name}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-mono text-xs">
                      {h.asset === "core" ? "WordPress" : h.name} {h.version}
                    </span>
                    <span className="text-xs break-words text-muted-foreground">
                      Rolled back {formatUtc(h.at)}: {h.reason}
                    </span>
                  </span>
                  {canManage && (
                    <ActionForm action={clearHoldAction} submitLabel="Try again" variant="outline">
                      <input type="hidden" name="siteId" value={siteId} />
                      <input type="hidden" name="asset" value={h.asset} />
                      <input type="hidden" name="name" value={h.name} />
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              A held version isn&apos;t tried again until a newer one is offered or you choose Try
              again.
            </p>
          </div>
        )}
        {canManage && (
          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer">
              Window and skip list
              {v.skip.length > 0 && ` (${v.skip.length} skipped)`}
            </summary>
            <div className="mt-3">
              <AutoUpdateSettingsForm
                siteId={siteId}
                window={v.window}
                skip={v.skip}
                // Only names the skip list accepts (A53 rules).
                installed={installed.filter((i) => PluginName.safeParse(i.name).success)}
              />
            </div>
          </details>
        )}
        {v.runs.length > 0 ? (
          <div className="grid gap-2">
            <p className="text-sm font-medium">Recent runs</p>
            {v.runs.map((run) => (
              <RunReport key={run.id} run={run} />
            ))}
          </div>
        ) : (
          v.enabled && <p className="text-sm text-muted-foreground">No runs yet.</p>
        )}
      </div>
    </details>
  );
}
