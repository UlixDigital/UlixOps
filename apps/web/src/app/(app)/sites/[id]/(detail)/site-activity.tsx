// "Working on this site" banner for every site tab (A136). Long commands keep running after
// the browser stops waiting (Cloudflare cuts requests at ~100 s); this shows them and refreshes
// the page until they end.
import { SiteJobList } from "@ulixops/shared";
import Link from "next/link";
import { LiveRefresh } from "@/app/(app)/deployments/[id]/live-refresh";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { ENV_LABELS } from "@/lib/site-status";

/** A job still RUNNING after this long was cut off (API restart); don't poll for it forever. */
const STALE_MS = 30 * 60_000;

export async function SiteActivity({ siteId }: { siteId: string }) {
  const res = await apiGet(`/sites/${siteId}/jobs?limit=10`, SiteJobList, await apiAuth());
  if (!res.ok) return null;
  const now = Date.now();
  const running = res.data.jobs.filter(
    (j) => j.status === "RUNNING" && now - Date.parse(j.startedAt) < STALE_MS,
  );
  if (running.length === 0) return null;
  return (
    <>
      <LiveRefresh intervalMs={5_000} />
      <Notice>
        Working on this site:{" "}
        {running.map((j, i) => (
          <span key={j.id}>
            {i > 0 && ", "}
            {j.summary} ({ENV_LABELS[j.kind].toLowerCase()}, started {timeAgo(j.startedAt)})
          </span>
        ))}
        . This page refreshes when it finishes; results appear under{" "}
        <Link href={`/sites/${siteId}/logs`} className="text-link hover:underline">
          Logs
        </Link>
        .
      </Notice>
    </>
  );
}
