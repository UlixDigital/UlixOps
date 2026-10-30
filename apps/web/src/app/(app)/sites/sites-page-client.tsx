"use client";

import { SiteList, type SiteView } from "@ulixops/shared";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { HOST_LABELS } from "@/lib/site-status";
import { cn } from "@/lib/utils";
import { SiteQuickActions } from "./site-quick-actions";
import { SitesTable } from "./sites-table";

export function SitesPageClient({
  canManage,
  canRefresh,
  archived,
  host,
  tag,
  initialSites,
  initialError,
}: {
  canManage: boolean;
  canRefresh: boolean;
  archived: boolean;
  host: string;
  tag: string;
  initialSites: SiteView[];
  initialError: boolean;
}) {
  const [all, setAll] = useState<SiteView[]>(initialSites);
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);

  // Soft-nav can reuse this client with a stale useState; re-apply the SSR seed when it changes.
  useEffect(() => {
    setAll(initialSites);
    setError(initialError);
  }, [initialSites, initialError]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      // Bust browser/CDN caches that may still hold an old 2-site payload (A125).
      const qs = new URLSearchParams();
      if (archived) qs.set("archived", "1");
      qs.set("_", String(Date.now()));
      const res = await fetch(`/api/sites/list?${qs}`, {
        cache: "no-store",
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      });
      if (!res.ok) {
        setError(true);
        return;
      }
      const parsed = SiteList.safeParse(await res.json());
      if (!parsed.success) {
        setError(true);
        return;
      }
      setAll(parsed.data.sites);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [archived]);

  useEffect(() => {
    void load();
  }, [load]);

  const tags = useMemo(() => [...new Set(all.flatMap((s) => s.tags))].sort(), [all]);
  const sites = useMemo(
    () => all.filter((s) => (!host || s.host === host) && (!tag || s.tags.includes(tag))),
    [all, host, tag],
  );

  const filterLink = (next: Record<string, string>) => {
    const query = new URLSearchParams({
      ...(archived ? { archived: "1" } : {}),
      ...(host ? { host } : {}),
      ...(tag ? { tag } : {}),
      ...next,
    });
    for (const [key, value] of [...query]) if (!value) query.delete(key);
    return `/sites${query.size ? `?${query}` : ""}`;
  };
  const chip = (active: boolean) =>
    cn(
      "rounded-md border px-2 py-1 text-xs transition-colors duration-150",
      active
        ? "border-primary bg-primary/10 font-medium"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sites</h1>
          <p className="text-sm text-muted-foreground">
            {all.length} {archived ? "sites, including archived" : "active sites"}
            {loading ? " · refreshing…" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonVariants({ variant: "outline" })}
            onClick={() => void load()}
            disabled={loading}
          >
            Refresh list
          </button>
          {canManage && (
            <Link href="/sites/new" className={buttonVariants()}>
              Add site
            </Link>
          )}
        </div>
      </div>

      {error && (
        <Notice tone="error">
          Could not refresh the live list (showing {all.length} loaded).{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            Try again
          </button>
          .
        </Notice>
      )}

      {all.length === 0 && !archived ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No sites yet</CardTitle>
            <CardDescription>
              {canManage
                ? "Create an SSH key in Settings → Credentials, install its public key on the site, then add the site here."
                : "An Admin adds sites. They'll appear here."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <nav aria-label="Filters" className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Host</span>
            <Link href={filterLink({ host: "" })} className={chip(!host)}>
              All
            </Link>
            {(["WPENGINE", "OTHER"] as const).map((h) => (
              <Link key={h} href={filterLink({ host: h })} className={chip(host === h)}>
                {HOST_LABELS[h]}
              </Link>
            ))}
            {tags.length > 0 && <span className="ml-2 text-xs text-muted-foreground">Tag</span>}
            {tags.length > 0 && (
              <Link href={filterLink({ tag: "" })} className={chip(!tag)}>
                All
              </Link>
            )}
            {tags.map((t) => (
              <Link key={t} href={filterLink({ tag: t })} className={chip(tag === t)}>
                {t}
              </Link>
            ))}
            <Link
              href={filterLink({ archived: archived ? "" : "1" })}
              className={cn(chip(archived), "ml-auto")}
            >
              {archived ? "Hide archived" : "Show archived"}
            </Link>
          </nav>
          {(canManage || canRefresh) && (
            <SiteQuickActions sites={sites} canManage={canManage} canRefresh={canRefresh} />
          )}
          <SitesTable sites={sites} />
        </>
      )}
    </div>
  );
}
