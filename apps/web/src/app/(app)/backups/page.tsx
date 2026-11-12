// Spec screen 13 (P1): quick snapshots across all sites. Full backups: ./full (A145).
import { BackupList } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { EnvBadge } from "@/components/env-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc, timeAgo } from "@/lib/format";
import { BackupsTabs } from "./backups-tabs";

export const metadata: Metadata = { title: "Backups · UlixOps" };

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function BackupsPage() {
  await requireSession();
  const res = await apiGet("/backups", BackupList, await apiAuth());

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Backups & snapshots</h1>
        <p className="text-sm text-muted-foreground">
          Quick pre-update snapshots of a plugin folder (encrypted, with retention). Weekly full
          backups of every site are under Full backups.
        </p>
      </div>
      <BackupsTabs active="/backups" />

      {!res.ok && (
        <Notice tone="error">Snapshots couldn&apos;t be loaded. Refresh the page.</Notice>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick snapshots</CardTitle>
          <CardDescription>
            {res.ok ? `${res.data.backups.length} recent` : "—"}. Open a site to take or restore
            one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {res.ok && res.data.backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No snapshots yet. From a site&apos;s Snapshots & backups tab, snapshot a plugin before
              updating it.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {(res.ok ? res.data.backups : []).map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="grid gap-0.5">
                    <Link
                      href={`/sites/${b.siteId}/snapshots${b.environment === "STAGING" ? "?env=staging" : ""}`}
                      className="flex flex-wrap items-center gap-2 font-medium hover:underline"
                    >
                      <span>{b.siteName}</span>
                      <EnvBadge kind={b.environment} />
                      <span className="font-normal text-muted-foreground">
                        {b.pluginName ?? "plugin"}
                        {b.pluginVersion ? ` ${b.pluginVersion}` : ""}
                      </span>
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      <span title={formatUtc(b.createdAt)}>{timeAgo(b.createdAt)}</span>
                      {b.createdBy && ` · ${b.createdBy.email}`}
                      {b.includesDb && " · includes DB"}
                      {` · ${formatBytes(b.sizeBytes)} · ${b.status.toLowerCase()}`}
                      {b.expiresAt && (
                        <>
                          {" · expires "}
                          <span title={formatUtc(b.expiresAt)}>{timeAgo(b.expiresAt)}</span>
                        </>
                      )}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
