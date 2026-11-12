// Wordfence feed status card, shared by the Security page and a site's Security tab.
import type { VulnFeedStatus } from "@ulixops/shared";
import Link from "next/link";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { Notice } from "@/components/ui/notice";
import { formatUtc, timeAgo } from "@/lib/format";

export function FeedStatusLine({ feed }: { feed: VulnFeedStatus }) {
  if (feed.running)
    return (
      <>
        <LiveRefresh intervalMs={5_000} />
        <Notice>Syncing the Wordfence feed. This page updates when it finishes.</Notice>
      </>
    );
  if (feed.lastSuccessAt === null && feed.ok === null)
    return (
      <Notice>
        No vulnerability data yet. An Admin adds the Wordfence Intelligence API key in{" "}
        <Link href="/settings/credentials" className="text-link hover:underline">
          Settings → Credentials
        </Link>{" "}
        (a second Admin approves); the feed then syncs daily.
      </Notice>
    );
  return (
    <div className="grid gap-2">
      {feed.ok === false && (
        <Notice tone="error">
          The last feed sync failed{feed.lastAttemptAt ? ` ${timeAgo(feed.lastAttemptAt)}` : ""}:{" "}
          {feed.error ?? "unknown error"}
        </Notice>
      )}
      {feed.lastSuccessAt && (
        <p className="text-xs text-muted-foreground" title={formatUtc(feed.lastSuccessAt)}>
          Feed synced {timeAgo(feed.lastSuccessAt)}: {feed.records ?? 0} records about software on
          our sites, out of {feed.total ?? 0} in the Wordfence database. Syncs daily; findings also
          update after every inventory refresh.
        </p>
      )}
    </div>
  );
}
