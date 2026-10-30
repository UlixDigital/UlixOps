"use client";
// Bulk update review gate + submit (A104 / A108).
import type { BulkUpdatePlanItem, EnvKind, VersionJumpSafety } from "@ulixops/shared";
import { useMemo, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { bulkUpdateAction } from "../../../actions";

const SAFETY_LABEL: Record<VersionJumpSafety, string> = {
  patch: "Patch",
  minor: "Minor",
  major: "Major",
  unknown: "Unknown",
};

const SAFETY_CLASS: Record<VersionJumpSafety, string> = {
  patch: "bg-success/10 text-success",
  minor: "bg-muted text-muted-foreground",
  major: "bg-destructive/10 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

function itemKey(item: BulkUpdatePlanItem): string {
  return `${item.asset}:${item.name}`;
}

export function BulkUpdateForm({
  siteId,
  kind,
  where,
  plan,
}: {
  siteId: string;
  kind: EnvKind;
  where: string;
  plan: BulkUpdatePlanItem[];
}) {
  const [reviewing, setReviewing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(plan.map(itemKey)));

  const chosen = useMemo(() => plan.filter((p) => selected.has(itemKey(p))), [plan, selected]);
  const count = chosen.length;
  const needsApproval = kind === "PRODUCTION" && count >= 2;

  if (plan.length < 1) return null;

  if (!reviewing) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Review each item (name, current → target version, jump size), include or remove rows, then
          submit. Production updates of two or more items wait for another Admin.
        </p>
        <Button type="button" onClick={() => setReviewing(true)}>
          Update all outdated ({plan.length})
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2">
                <span className="sr-only">Include</span>
              </th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Current</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">Jump</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {plan.map((item) => {
              const key = itemKey(item);
              const on = selected.has(key);
              return (
                <tr key={key} className={cn(!on && "opacity-50")}>
                  <td className="px-3 py-2 align-middle">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={on}
                      onChange={() => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        });
                      }}
                      aria-label={`Include ${item.name}`}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs break-all">{item.name}</td>
                  <td className="px-3 py-2 capitalize text-muted-foreground">{item.asset}</td>
                  <td className="px-3 py-2 font-mono text-xs">{item.version}</td>
                  <td className="px-3 py-2 font-mono text-xs">{item.updateVersion}</td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "rounded-md px-1.5 py-0.5 text-xs font-medium",
                        SAFETY_CLASS[item.safety],
                      )}
                    >
                      {SAFETY_LABEL[item.safety]}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => setReviewing(false)}>
          Cancel
        </Button>
        {count < 1 ? (
          <p className="text-sm text-muted-foreground">Select at least one item to continue.</p>
        ) : (
          <ActionForm
            action={bulkUpdateAction}
            submitLabel={
              needsApproval
                ? `Send ${count} item${count === 1 ? "" : "s"} for approval`
                : `Update ${count} selected`
            }
            pendingLabel={
              needsApproval
                ? "Submitting for approval…"
                : `Updating ${count} item${count === 1 ? "" : "s"}…`
            }
            expectedMs={needsApproval ? 15_000 : Math.min(900_000, 45_000 * count)}
            confirm={{
              title: needsApproval
                ? `Request approval to update ${count} item${count === 1 ? "" : "s"} on ${where}?`
                : `Update ${count} item${count === 1 ? "" : "s"} on ${where}?`,
              description: needsApproval
                ? "Another Admin must approve. Only the items you kept will run after approval. Each item is snapshotted, updated, then health-checked (auto-rollback on breakage)."
                : "Each selected item is snapshotted, updated, then health-checked. Auto-rollback runs if health fails. Google Drive full backups are not available yet.",
            }}
            className="flex-1 sm:flex-initial"
          >
            <input type="hidden" name="siteId" value={siteId} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="strategy" value="snapshots" />
            <input type="hidden" name="items" value={JSON.stringify(chosen)} />
            <fieldset className="mb-3 grid gap-2 text-sm">
              <legend className="mb-1 font-medium">Before updating</legend>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="strategyRadio"
                  value="snapshots"
                  defaultChecked
                  disabled
                  className="mt-1 size-4"
                />
                <span>
                  <span className="font-medium">Quick snapshots</span>
                  <span className="block text-muted-foreground">
                    Snapshot each selected plugin and theme on this environment, then update.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 opacity-60">
                <input
                  type="radio"
                  name="strategyRadio"
                  value="google_drive"
                  disabled
                  className="mt-1 size-4"
                />
                <span>
                  <span className="font-medium">Full backup to Google Drive</span>
                  <span className="block text-muted-foreground">
                    Not configured yet (Phase 2). Use Snapshots for now.
                  </span>
                </span>
              </label>
            </fieldset>
          </ActionForm>
        )}
      </div>
    </div>
  );
}
