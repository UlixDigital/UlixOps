"use client";
import { useActionState, useMemo, useState } from "react";
import type { ActionState } from "@/components/action-form";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createDeploymentAction } from "../actions";

interface PluginOption {
  slug: string;
  name: string;
  latestVersion: string | null;
}

interface SiteOption {
  id: string;
  name: string;
  url: string;
  tags: string[];
  host: string;
  productionPinned: boolean;
  hasStaging: boolean;
  stagingPinned: boolean;
}

interface VersionOption {
  version: string;
  changelog: string;
}

export function DeployWizard({
  plugins,
  siteOptions,
  initialPlugin,
  initialVersion,
  initialSiteIds,
  versionsForPlugin,
}: {
  plugins: PluginOption[];
  siteOptions: SiteOption[];
  initialPlugin: string;
  initialVersion?: string;
  initialSiteIds: string[];
  versionsForPlugin: VersionOption[];
}) {
  const [step, setStep] = useState(1);
  const [pluginSlug, setPluginSlug] = useState(
    initialPlugin && plugins.some((p) => p.slug === initialPlugin)
      ? initialPlugin
      : (plugins[0]?.slug ?? ""),
  );
  const [version, setVersion] = useState(
    initialVersion ??
      plugins.find((p) => p.slug === (initialPlugin || plugins[0]?.slug))?.latestVersion ??
      "",
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSiteIds.filter((id) => siteOptions.some((s) => s.id === id))),
  );
  const [tagFilter, setTagFilter] = useState("");
  const [stagingFirst, setStagingFirst] = useState(true);
  const [batchSize, setBatchSize] = useState(2);
  const [pauseOnFailure, setPauseOnFailure] = useState(true);
  const [state, action] = useActionState<ActionState, FormData>(createDeploymentAction, {});

  const plugin = plugins.find((p) => p.slug === pluginSlug);
  const tags = useMemo(
    () => [...new Set(siteOptions.flatMap((s) => s.tags))].sort(),
    [siteOptions],
  );
  const visible = siteOptions.filter((s) => !tagFilter || s.tags.includes(tagFilter));
  const chosen = siteOptions.filter((s) => selected.has(s.id));
  const needsApproval = chosen.length > 1;
  const unpinned = chosen.filter(
    (s) => !s.productionPinned || (stagingFirst && s.hasStaging && !s.stagingPinned),
  );

  const versions =
    pluginSlug === initialPlugin && versionsForPlugin.length > 0
      ? versionsForPlugin
      : plugin?.latestVersion
        ? [{ version: plugin.latestVersion, changelog: "" }]
        : [];

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectVisible(all: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visible) {
        if (all) next.add(s.id);
        else next.delete(s.id);
      }
      return next;
    });
  }

  return (
    <div className="grid gap-4">
      <ol className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {["Plugin", "Sites", "Settings", "Review"].map((label, i) => (
          <li
            key={label}
            className={
              step === i + 1 ? "font-medium text-foreground" : step > i + 1 ? "text-foreground" : ""
            }
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Plugin and version</CardTitle>
            <CardDescription>
              Only versions already in the registry can be deployed.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {plugins.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Upload a plugin version first, then come back here.
              </p>
            ) : (
              <>
                <label className="grid gap-1 text-sm">
                  <span className="font-medium">Plugin</span>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3"
                    value={pluginSlug}
                    onChange={(e) => {
                      const slug = e.target.value;
                      setPluginSlug(slug);
                      const latest = plugins.find((p) => p.slug === slug)?.latestVersion ?? "";
                      setVersion(latest);
                    }}
                  >
                    {plugins.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.name} ({p.slug})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="font-medium">Version</span>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 font-mono"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                  >
                    {versions.map((v) => (
                      <option key={v.version} value={v.version}>
                        {v.version}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <div className="flex justify-end">
              <Button type="button" disabled={!pluginSlug || !version} onClick={() => setStep(2)}>
                Next
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sites</CardTitle>
            <CardDescription>
              Production is always included. Sites without a pinned host key can&apos;t be selected.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-xs ${!tagFilter ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground"}`}
                  onClick={() => setTagFilter("")}
                >
                  All tags
                </button>
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`rounded-md border px-2 py-1 text-xs ${tagFilter === tag ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground"}`}
                    onClick={() => setTagFilter(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2 text-xs">
              <button
                type="button"
                className="text-link hover:underline"
                onClick={() => selectVisible(true)}
              >
                Select visible
              </button>
              <button
                type="button"
                className="text-link hover:underline"
                onClick={() => selectVisible(false)}
              >
                Clear visible
              </button>
            </div>
            <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
              {visible.map((s) => {
                const disabled = !s.productionPinned;
                return (
                  <li key={s.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(s.id)}
                      disabled={disabled}
                      onChange={() => toggle(s.id)}
                      aria-label={s.name}
                    />
                    <div className="min-w-0">
                      <p className="font-medium">{s.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.url}</p>
                      {!s.productionPinned && (
                        <p className="text-xs text-destructive">Run Test connection first</p>
                      )}
                      {s.hasStaging && (
                        <p className="text-xs text-muted-foreground">
                          Has staging{s.stagingPinned ? "" : " (untested)"}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">{selected.size} selected</p>
            <div className="flex justify-between">
              <Button type="button" variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="button" disabled={selected.size === 0} onClick={() => setStep(3)}>
                Next
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Rollout settings</CardTitle>
            <CardDescription>
              Staging runs first where available, then production in batches.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={stagingFirst}
                onChange={(e) => setStagingFirst(e.target.checked)}
              />
              <span>
                <span className="font-medium">Staging first</span>
                <span className="block text-muted-foreground">
                  Deploy and health-check each site&apos;s staging environment before production.
                </span>
              </span>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Batch size (production)</span>
              <input
                type="number"
                min={1}
                max={10}
                value={batchSize}
                onChange={(e) =>
                  setBatchSize(Math.min(10, Math.max(1, Number(e.target.value) || 1)))
                }
                className="h-9 w-24 rounded-md border border-input bg-background px-3"
              />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={pauseOnFailure}
                onChange={(e) => setPauseOnFailure(e.target.checked)}
              />
              <span>
                <span className="font-medium">Pause on failure</span>
                <span className="block text-muted-foreground">
                  Automatic rollback of the failed site, then pause the rest of the rollout.
                </span>
              </span>
            </label>
            <div className="flex justify-between">
              <Button type="button" variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button type="button" onClick={() => setStep(4)}>
                Next
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Review</CardTitle>
            <CardDescription>
              {needsApproval
                ? "This rollout needs another Admin on Approvals before it starts."
                : "Submitting starts the rollout immediately."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={action} className="grid gap-4">
              <FormPendingOverlay label="Starting deployment…" />
              <input type="hidden" name="pluginSlug" value={pluginSlug} />
              <input type="hidden" name="version" value={version} />
              {[...selected].map((id) => (
                <input key={id} type="hidden" name="siteIds" value={id} />
              ))}
              {stagingFirst && <input type="hidden" name="stagingFirst" value="on" />}
              {pauseOnFailure && <input type="hidden" name="pauseOnFailure" value="on" />}
              <input type="hidden" name="batchSize" value={batchSize} />

              <dl className="grid gap-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Plugin</dt>
                  <dd>
                    {plugin?.name} <span className="font-mono">{version}</span>
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Sites</dt>
                  <dd>{chosen.map((s) => s.name).join(", ")}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Staging first</dt>
                  <dd>{stagingFirst ? "Yes" : "No"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Batch size</dt>
                  <dd>{batchSize}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Pause on failure</dt>
                  <dd>{pauseOnFailure ? "Yes" : "No"}</dd>
                </div>
              </dl>

              {unpinned.length > 0 && (
                <p role="alert" className="text-sm text-destructive">
                  These sites still need Test connection: {unpinned.map((s) => s.name).join(", ")}.
                </p>
              )}
              {state.error && (
                <p role="alert" className="text-sm text-destructive">
                  {state.error}
                </p>
              )}

              <div className="flex justify-between">
                <Button type="button" variant="outline" onClick={() => setStep(3)}>
                  Back
                </Button>
                <PendingSubmit pendingLabel="Submitting…">
                  {needsApproval ? "Request approval" : "Start deployment"}
                </PendingSubmit>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
