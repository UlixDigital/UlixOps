// One file integrity check (A144): changed files by component, mark-as-expected, rules.
import {
  can,
  INTEGRITY_ISSUE_LABELS,
  IntegrityCheckDetail,
  type IntegrityFindingView,
} from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { ActionForm } from "@/components/action-form";
import { EnvBadge } from "@/components/env-badge";
import { IntegrityBadge } from "@/components/integrity-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { scanDuration } from "@/lib/malware";
import { cn } from "@/lib/utils";
import {
  markChangeSafeAction,
  removeChangeRuleAction,
  startIntegrityCheckAction,
} from "../actions";

export const metadata: Metadata = { title: "File integrity check · UlixOps" };

const ISSUE_TONE = {
  modified: "text-destructive",
  added: "text-destructive",
  missing: "text-warning",
} as const;

function group(findings: IntegrityFindingView[]) {
  const map = new Map<string, IntegrityFindingView[]>();
  for (const f of findings) {
    const k = f.scope === "core" ? "WordPress core" : f.component;
    map.set(k, [...(map.get(k) ?? []), f]);
  }
  return [...map.entries()];
}

export default async function IntegrityCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireSession();
  const id = (await params).id;
  if (!/^[a-z0-9]{1,64}$/.test(id)) notFound();
  const res = await apiGet(`/integrity-checks/${id}`, IntegrityCheckDetail, await apiAuth());
  if (!res.ok) notFound();
  const { check, ignores } = res.data;
  const canCheck = can(user.role, "sites.refresh");
  const canManage = can(user.role, "settings.manage");
  const real = check.findings.filter((f) => !f.ignored);
  const expected = check.findings.filter((f) => f.ignored);
  const running = check.status === "RUNNING";

  return (
    <div className="grid gap-4">
      {running && <LiveRefresh intervalMs={3_000} />}
      <Link
        href="/security/integrity"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← File integrity
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            <Link href={`/sites/${check.siteId}/security`} className="hover:underline">
              {check.siteName}
            </Link>
          </h1>
          <EnvBadge kind={check.environment} />
          <IntegrityBadge status={check.status} />
        </div>
        {canCheck && !running && (
          <ActionForm
            action={startIntegrityCheckAction}
            submitLabel="Check again"
            variant="outline"
          >
            <input type="hidden" name="siteId" value={check.siteId} />
            <input type="hidden" name="kind" value={check.environment} />
          </ActionForm>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
          {check.detail && <CardDescription>{check.detail}</CardDescription>}
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            {(
              [
                ["Started", `${formatUtc(check.startedAt)} (${timeAgo(check.startedAt)})`],
                ["Took", scanDuration(check)],
                ["Started by", check.requestedBy ?? "Daily schedule"],
                ["WordPress core", check.coreChecked ? "Checked" : "Couldn't be checked"],
                [
                  "Plugins",
                  check.pluginsChecked
                    ? `${check.verifiedPlugins} checked`
                    : "Couldn't be checked (WordPress didn't load)",
                ],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {real.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">
              {real.length} file{real.length === 1 ? "" : "s"} differ from WordPress.org
            </CardTitle>
            <CardDescription>
              Unexpected changes are a strong sign of a hack. Expected ones happen when someone
              edited a plugin by hand. Reinstalling the same version (or updating) restores the
              official files.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {group(real).map(([name, files]) => (
              <section key={name} className="grid gap-2">
                <h3 className="text-sm font-medium">{name}</h3>
                <ul className="grid gap-2">
                  {files.map((f) => (
                    <li key={f.id} className="grid gap-1.5 rounded-md border p-3">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs break-all">{f.path}</span>
                        <span className={cn("text-xs font-medium", ISSUE_TONE[f.issue])}>
                          {INTEGRITY_ISSUE_LABELS[f.issue]}
                        </span>
                      </span>
                      {canManage && (
                        <details className="text-sm">
                          <summary className="cursor-pointer text-muted-foreground">
                            Reviewed: this change is expected
                          </summary>
                          <ActionForm
                            action={markChangeSafeAction}
                            submitLabel="Mark as expected"
                            variant="outline"
                            className="mt-2"
                            confirm={{
                              title: "Mark this change as expected?",
                              description: `Later checks of ${check.siteName} will still record ${f.path}, but won't count it or alert. Only do this after checking the file. It's in the audit log and can be undone.`,
                            }}
                          >
                            <input type="hidden" name="findingId" value={f.id} />
                            <input type="hidden" name="checkId" value={check.id} />
                            <div className="grid max-w-md gap-1.5">
                              <Label htmlFor={`reason-${f.id}`}>Why is it expected?</Label>
                              <Input
                                id={`reason-${f.id}`}
                                name="reason"
                                required
                                minLength={3}
                                maxLength={300}
                                placeholder="e.g. hosting provider's file, patched on purpose"
                              />
                            </div>
                          </ActionForm>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </CardContent>
        </Card>
      )}

      {check.unverifiable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not verifiable</CardTitle>
            <CardDescription>
              WordPress.org has no checksums for these plugins (premium or custom). The malware scan
              still covers them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-xs leading-relaxed break-words text-muted-foreground">
              {check.unverifiable.join(", ")}
            </p>
          </CardContent>
        </Card>
      )}

      {expected.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Expected changes in this check</CardTitle>
            <CardDescription>Recorded, but not counted or alerted on.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-sm text-muted-foreground">
              {expected.map((f) => (
                <li key={f.id}>
                  {f.scope === "plugin" ? `${f.component} › ` : ""}
                  <span className="font-mono text-xs break-all">{f.path}</span> ·{" "}
                  {INTEGRITY_ISSUE_LABELS[f.issue]}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {ignores.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Expected-change rules for this site</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-md border text-sm">
              {ignores.map((rule) => (
                <li
                  key={rule.id}
                  className="flex flex-wrap items-start justify-between gap-2 px-3 py-2"
                >
                  <span className="grid gap-0.5">
                    <span className="font-mono text-xs break-all">
                      {rule.scope === "plugin" ? `${rule.component} › ` : ""}
                      {rule.path}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      “{rule.reason}” · {rule.createdBy ?? "removed user"},{" "}
                      {timeAgo(rule.createdAt)}
                    </span>
                  </span>
                  {canManage && (
                    <ActionForm
                      action={removeChangeRuleAction}
                      submitLabel="Remove"
                      variant="outline"
                    >
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <input type="hidden" name="checkId" value={check.id} />
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
