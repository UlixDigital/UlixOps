"use client";
// Every site's scheduled updates, with switching on several at once (A162).
import { type AutoUpdateOverviewRow, WEEKDAYS } from "@ulixops/shared";
import Link from "next/link";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { RunBadge } from "@/components/auto-update-parts";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { windowLabel } from "@/lib/autoupdates";
import { formatUtc, timeAgo } from "@/lib/format";
import { hourLabel } from "@/lib/malware";
import { enableAutoUpdatesAction } from "./actions";

export function AutoUpdateOverviewTable({
  rows,
  canManage,
}: {
  rows: AutoUpdateOverviewRow[];
  canManage: boolean;
}) {
  const selectable = (r: AutoUpdateOverviewRow) => canManage && !r.enabled && !r.pendingApproval;
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const picked = rows.filter((r) => chosen.has(r.siteId));
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const all = rows.filter(selectable);

  return (
    <div className="grid gap-4">
      {canManage && all.length > 0 && (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-sm">
            {picked.length === 0
              ? "Tick the sites to switch on."
              : `${picked.length} site${picked.length === 1 ? "" : "s"} chosen.`}{" "}
            <button
              type="button"
              className="text-link hover:underline"
              onClick={() =>
                setChosen(
                  picked.length === all.length ? new Set() : new Set(all.map((r) => r.siteId)),
                )
              }
            >
              {picked.length === all.length ? "Clear" : "Choose all"}
            </button>
          </p>
          {picked.length > 0 && (
            <ActionForm
              action={enableAutoUpdatesAction}
              submitLabel={`Switch on for ${picked.length} site${picked.length === 1 ? "" : "s"}`}
              confirm={{
                title: `Switch scheduled updates on for ${picked.length} site${picked.length === 1 ? "" : "s"}?`,
                description: `${picked
                  .map((r) => r.siteName)
                  .slice(0, 8)
                  .join(
                    ", ",
                  )}${picked.length > 8 ? ` and ${picked.length - 8} more` : ""}. Patch and minor updates then install unattended in each site's window, staging first where there is one, with a snapshot, a health check and a rollback per item. Another Admin approves first (a Super Admin approves their own).`,
              }}
            >
              {picked.map((r) => (
                <input key={r.siteId} type="hidden" name="siteId" value={r.siteId} />
              ))}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="bulk-day">Day (sites without a window yet)</Label>
                  <Select id="bulk-day" name="dayOfWeek" defaultValue={2}>
                    {WEEKDAYS.map((name, i) => (
                      <option key={name} value={i}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="bulk-hour">Start at (UTC)</Label>
                  <Select id="bulk-hour" name="hourUtc" defaultValue={6}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)} UTC
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </ActionForm>
          )}
        </div>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              {canManage && (
                <th className="w-10 px-3 py-2">
                  <span className="sr-only">Choose</span>
                </th>
              )}
              <th className="px-3 py-2 font-medium">Site</th>
              <th className="px-3 py-2 font-medium">Scheduled updates</th>
              <th className="px-3 py-2 font-medium">Next run</th>
              <th className="px-3 py-2 font-medium">Last run</th>
              <th className="px-3 py-2 font-medium">Held</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.siteId}>
                {canManage && (
                  <td className="px-3 py-2">
                    {selectable(r) && (
                      <input
                        type="checkbox"
                        aria-label={`Choose ${r.siteName}`}
                        checked={chosen.has(r.siteId)}
                        onChange={() => toggle(r.siteId)}
                        className="size-4 rounded border border-input"
                      />
                    )}
                  </td>
                )}
                <td className="px-3 py-2">
                  <Link href={`/sites/${r.siteId}/plugins`} className="font-medium hover:underline">
                    {r.siteName}
                  </Link>
                  {r.hasStaging && (
                    <span className="ml-2 text-xs text-muted-foreground">+ staging</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.enabled ? (
                    <span>On · {r.window ? windowLabel(r.window) : "—"}</span>
                  ) : r.pendingApproval ? (
                    <span className="text-warning">Waiting for approval</span>
                  ) : (
                    <span className="text-muted-foreground">Off</span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{formatUtc(r.nextWindowAt)}</td>
                <td className="px-3 py-2">
                  {r.lastRun ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <RunBadge status={r.lastRun.status} />
                      <span
                        className="text-xs text-muted-foreground"
                        title={formatUtc(r.lastRun.startedAt)}
                      >
                        {timeAgo(r.lastRun.startedAt)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums">{r.holds || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
