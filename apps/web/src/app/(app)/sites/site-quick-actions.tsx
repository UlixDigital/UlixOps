"use client";
// Sites list quick actions: multi-select, Live/Staging, one site at a time via stable API (A116–A119).
import type { EnvKind, SiteView } from "@ulixops/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { BusyOverlay } from "@/components/pending-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { HOST_LABELS } from "@/lib/site-status";
import { cn } from "@/lib/utils";
import { remoteBlocker } from "./[id]/(detail)/parts";

type QuickAction = "test" | "inventory" | "updates" | "health";
type HostFilter = "" | "WPENGINE" | "OTHER";
/** Filter the picker list by whether the site has a staging environment. */
type StagingFilter = "all" | "live_only" | "has_staging";

type SiteResult = {
  siteId: string;
  name: string;
  ok: boolean;
  unhealthy?: boolean;
  detail: string;
};

function pickEnv(site: SiteView, kind: EnvKind) {
  return site.environments.find((e) => e.kind === kind) ?? null;
}

/** Calls the stable route (not a hashed Server Action) so deploys mid-batch don't break (A119). */
async function runOne(action: QuickAction, site: SiteView, envKind: EnvKind): Promise<SiteResult> {
  const env = pickEnv(site, envKind);
  if (!env) {
    return {
      siteId: site.id,
      name: site.name,
      ok: false,
      detail:
        envKind === "STAGING"
          ? "No staging environment on this site — skipped."
          : "No production environment — skipped.",
    };
  }
  const blocked = remoteBlocker(site, env);
  if (blocked && action !== "test") {
    return { siteId: site.id, name: site.name, ok: false, detail: blocked };
  }
  try {
    const res = await fetch("/api/sites/quick-action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteId: site.id,
        kind: env.kind,
        action,
        siteName: site.name,
      }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok || !json || typeof json !== "object") {
      return {
        siteId: site.id,
        name: site.name,
        ok: false,
        detail:
          res.status === 401
            ? "Session expired — refresh and sign in again."
            : `Request failed (${res.status})`,
      };
    }
    const row = json as SiteResult;
    return {
      siteId: row.siteId ?? site.id,
      name: row.name ?? site.name,
      ok: row.ok === true,
      unhealthy: row.unhealthy === true,
      detail: typeof row.detail === "string" ? row.detail : "No result",
    };
  } catch (error) {
    return {
      siteId: site.id,
      name: site.name,
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 300) : "Unexpected error",
    };
  }
}

/** Disabled stand-ins so the action row is visible before sites are chosen. */
function DisabledActions() {
  return (
    <div className="flex flex-wrap gap-2" aria-hidden>
      <Button type="button" variant="outline" disabled>
        Test connection
      </Button>
      <Button type="button" variant="outline" disabled>
        Refresh inventory
      </Button>
      <Button type="button" variant="outline" disabled>
        Check for updates
      </Button>
      <Button type="button" variant="outline" disabled>
        Run health check
      </Button>
    </div>
  );
}

export function SiteQuickActions({
  sites,
  canManage,
  canRefresh,
}: {
  sites: SiteView[];
  canManage: boolean;
  canRefresh: boolean;
}) {
  const usable = useMemo(() => sites.filter((s) => !s.archived), [sites]);
  const tags = useMemo(() => [...new Set(usable.flatMap((s) => s.tags))].sort(), [usable]);
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [envKind, setEnvKind] = useState<EnvKind>("PRODUCTION");
  const [query, setQuery] = useState("");
  const [hostFilter, setHostFilter] = useState<HostFilter>("");
  const [stagingFilter, setStagingFilter] = useState<StagingFilter>("all");
  const [tagFilter, setTagFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<SiteResult[] | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return usable.filter((s) => {
      if (hostFilter && s.host !== hostFilter) return false;
      if (tagFilter && !s.tags.includes(tagFilter)) return false;
      const hasStaging = s.environments.some((e) => e.kind === "STAGING");
      if (stagingFilter === "live_only" && hasStaging) return false;
      if (stagingFilter === "has_staging" && !hasStaging) return false;
      if (!q) return true;
      const hay = `${s.name} ${s.url} ${s.tags.join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [usable, query, hostFilter, stagingFilter, tagFilter]);

  const selected = useMemo(
    () => usable.filter((s) => selectedIds.includes(s.id)),
    [usable, selectedIds],
  );
  const anyDualEnv = selected.some((s) => s.environments.length > 1);
  const hasSelection = selected.length > 0;
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((s) => selectedIds.includes(s.id));

  function toggle(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setResults(null);
  }

  /** Tick every site currently visible after filters (bulk select for actions). */
  function selectFiltered() {
    const ids = filtered.map((s) => s.id);
    setSelectedIds((prev) => [...new Set([...prev, ...ids])]);
    setResults(null);
  }

  function clearSelection() {
    setSelectedIds([]);
    setResults(null);
  }

  function toggleFiltered() {
    if (allFilteredSelected) {
      const drop = new Set(filtered.map((s) => s.id));
      setSelectedIds((prev) => prev.filter((id) => !drop.has(id)));
    } else {
      selectFiltered();
      return;
    }
    setResults(null);
  }

  async function runSequential(action: QuickAction) {
    const label =
      action === "test"
        ? "Test connection"
        : action === "inventory"
          ? "Refresh inventory"
          : action === "updates"
            ? "Check for updates"
            : "Health check";
    // One HTTP call per site, in order — not a bulk job; route stays stable across deploys (A119).
    const collected: SiteResult[] = [];
    for (let i = 0; i < selected.length; i++) {
      const site = selected[i];
      if (!site) continue;
      setProgress(`${label}: ${site.name} (${i + 1} of ${selected.length})…`);
      collected.push(await runOne(action, site, envKind));
    }
    setProgress(null);
    setResults(collected);
  }

  async function onAction(action: QuickAction) {
    if (!hasSelection || running) return;
    setResults(null);
    setOpen(true);
    setRunning(true);
    try {
      await runSequential(action);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  const summary = [
    `${usable.length} site${usable.length === 1 ? "" : "s"}`,
    hasSelection ? `${selectedIds.length} selected` : null,
    results ? `${results.filter((r) => r.ok).length}/${results.length} ok last run` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card>
      <CardHeader className="p-0">
        <button
          type="button"
          className="flex w-full items-start gap-2 rounded-t-xl px-6 py-4 text-left transition-colors duration-150 hover:bg-accent/40"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDown aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="grid min-w-0 flex-1 gap-1">
            <CardTitle className="text-base">Quick actions</CardTitle>
            <CardDescription>
              {open
                ? "Tick websites, pick Live or Staging when needed, then run an action. Sites run one at a time — a failure does not stop the others."
                : summary}
            </CardDescription>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="grid gap-4 border-t pt-4">
          <BusyOverlay pending={running} label={progress ?? "Working…"} expectedMs={45_000} />

          <div className="grid gap-2">
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">Search</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name, URL, or tag…"
                className="h-9 rounded-md border bg-background px-3 text-sm"
                autoComplete="off"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Host</span>
              {(
                [
                  { value: "" as const, label: "All" },
                  { value: "WPENGINE" as const, label: HOST_LABELS.WPENGINE },
                  { value: "OTHER" as const, label: HOST_LABELS.OTHER },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value || "all"}
                  type="button"
                  className={cn(
                    "rounded-md border px-2 py-1 transition-colors duration-150",
                    hostFilter === opt.value
                      ? "border-primary bg-primary/10 font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setHostFilter(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
              <span className="ml-2 text-muted-foreground">Envs</span>
              {(
                [
                  { value: "all" as const, label: "All sites" },
                  { value: "live_only" as const, label: "Live only" },
                  { value: "has_staging" as const, label: "Has staging" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={cn(
                    "rounded-md border px-2 py-1 transition-colors duration-150",
                    stagingFilter === opt.value
                      ? "border-primary bg-primary/10 font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setStagingFilter(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
              {tags.length > 0 && (
                <>
                  <span className="ml-2 text-muted-foreground">Tag</span>
                  <select
                    className="h-7 rounded-md border bg-background px-2 text-xs"
                    value={tagFilter}
                    onChange={(e) => setTagFilter(e.target.value)}
                    aria-label="Filter by tag"
                  >
                    <option value="">All tags</option>
                    {tags.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>

          <fieldset className="grid gap-2">
            <legend className="sr-only">Websites</legend>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {filtered.length} shown
                {filtered.length !== usable.length ? ` of ${usable.length}` : ""}
                {hasSelection ? ` · ${selectedIds.length} selected` : ""}
              </span>
              <div className="flex flex-wrap gap-3">
                {filtered.length > 0 && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={toggleFiltered}
                  >
                    {allFilteredSelected ? "Unselect shown" : "Select all shown"}
                  </button>
                )}
                {hasSelection && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={clearSelection}
                  >
                    Clear selection
                  </button>
                )}
              </div>
            </div>
            <ul className="max-h-48 overflow-y-auto rounded-md border divide-y">
              {filtered.length === 0 ? (
                <li className="px-3 py-4 text-sm text-muted-foreground">
                  No sites match these filters.
                </li>
              ) : (
                filtered.map((s) => {
                  const checked = selectedIds.includes(s.id);
                  return (
                    <li key={s.id}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50",
                          checked && "bg-accent/30",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="size-4 rounded border"
                          checked={checked}
                          onChange={() => toggle(s.id)}
                        />
                        <span className="font-medium">{s.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {s.url.replace(/^https?:\/\//, "")}
                        </span>
                        {s.environments.length > 1 && (
                          <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                            Live + Staging
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })
              )}
            </ul>
          </fieldset>

          {hasSelection && anyDualEnv && (
            <fieldset className="grid gap-1.5">
              <legend className="text-sm text-muted-foreground">Environment</legend>
              <div
                role="group"
                aria-label="Environment"
                className="inline-flex rounded-md border p-0.5"
              >
                {(
                  [
                    { kind: "PRODUCTION" as const, label: "Live" },
                    { kind: "STAGING" as const, label: "Staging" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.kind}
                    type="button"
                    aria-pressed={envKind === opt.kind}
                    className={cn(
                      "rounded px-3 py-1.5 text-sm transition-colors duration-150",
                      envKind === opt.kind
                        ? "bg-accent font-medium"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => {
                      setEnvKind(opt.kind);
                      setResults(null);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Actions run on {envKind === "STAGING" ? "Staging" : "Live"} for each selected site.
                Sites without that environment are skipped.
              </p>
            </fieldset>
          )}

          {!hasSelection && <Notice>Select at least one website to enable the actions.</Notice>}

          {!hasSelection ? (
            <DisabledActions />
          ) : (
            <div className="flex flex-wrap gap-2">
              {canManage && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={running}
                  onClick={() => void onAction("test")}
                >
                  Test connection
                </Button>
              )}
              {canRefresh && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={running}
                    onClick={() => void onAction("inventory")}
                  >
                    Refresh inventory
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={running}
                    onClick={() => void onAction("updates")}
                  >
                    Check for updates
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={running}
                    onClick={() => void onAction("health")}
                  >
                    Run health check
                  </Button>
                </>
              )}
              {!canManage && !canRefresh && (
                <p className="text-sm text-muted-foreground">
                  Your role can view sites but not run these actions.
                </p>
              )}
            </div>
          )}

          {results && results.length > 0 && (
            <ul className="grid gap-1.5 rounded-md border p-3 text-sm" role="status">
              {results.map((r) => (
                <li key={r.siteId} className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span
                    className={
                      r.ok ? "text-success" : r.unhealthy ? "text-warning" : "text-destructive"
                    }
                  >
                    {r.ok ? "OK" : r.unhealthy ? "Unhealthy" : "Failed"}
                  </span>
                  <span className="text-muted-foreground">{r.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}
