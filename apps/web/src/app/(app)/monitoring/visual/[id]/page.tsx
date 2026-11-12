import { isClientViewer, VisualCheckView } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Visual check · UlixOps" };

export default async function VisualCheckDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await requireSession();
  if (isClientViewer(user.role)) {
    return <NoAccess role={user.role} what="visual checks" />;
  }
  const { id } = await params;
  const res = await apiGet(`/visual-checks/${id}`, VisualCheckView, await apiAuth(), {
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    if (res.error === "not_found") notFound();
    return <Notice tone="error">This visual check couldn&apos;t be loaded.</Notice>;
  }
  const check = res.data;

  return (
    <div className="grid gap-4">
      <div>
        <p className="text-xs text-muted-foreground">
          <Link href="/monitoring/visual" className="hover:underline">
            Visual checks
          </Link>
          {" · "}
          <Link href={`/sites/${check.siteId}/visual`} className="hover:underline">
            {check.siteName}
          </Link>
        </p>
        <h1 className="text-xl font-semibold tracking-tight">
          {check.siteName}{" "}
          <span className="text-base font-normal text-muted-foreground">
            ({check.environment === "STAGING" ? "staging" : "live"})
          </span>
        </h1>
        <p className="text-sm text-muted-foreground">
          {check.trigger.replace("_", " ")} · {check.status} · {formatUtc(check.startedAt)}
          {check.summary ? ` · ${check.summary}` : ""}
        </p>
      </div>

      {check.pages.length === 0 ? (
        <Notice>No page screenshots were stored for this check.</Notice>
      ) : (
        check.pages.map((page) => (
          <Card key={page.id} className="grid gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="font-medium">{page.path}</h2>
                <p className="text-xs text-muted-foreground">{page.url}</p>
              </div>
              <p
                className={cn(
                  "text-sm font-medium",
                  page.changed ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
                )}
              >
                {page.diffPercent != null ? `${page.diffPercent}% changed` : page.detail}
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {(
                [
                  ["before", page.hasBefore],
                  ["after", page.hasAfter],
                  ["diff", page.hasDiff],
                ] as const
              ).map(([kind, has]) => (
                <figure key={kind} className="grid gap-1">
                  <figcaption className="text-xs font-medium capitalize text-muted-foreground">
                    {kind}
                  </figcaption>
                  {has ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/visual-checks/${check.id}/pages/${page.slug}/${kind}`}
                      alt={`${page.path} ${kind}`}
                      className="w-full rounded-md border bg-muted object-contain"
                    />
                  ) : (
                    <div className="flex aspect-video items-center justify-center rounded-md border bg-muted/40 text-xs text-muted-foreground">
                      Not captured
                    </div>
                  )}
                </figure>
              ))}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
