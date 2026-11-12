// Daily tick: on the 1st UTC, build last month's per-site reports (A165).
import type { ReportDeps } from "./service";
import { runScheduledMonthlyReports } from "./service";

const DAY_MS = 24 * 60 * 60_000;

export function startReportScheduler(deps: ReportDeps): () => void {
  let stopped = false;
  let running: Promise<void> | null = null;

  const tick = () => {
    if (stopped || running) return;
    running = runScheduledMonthlyReports(deps)
      .then((n) => {
        if (n > 0) console.log(`reports: generated ${n} monthly client report(s)`);
      })
      .catch((err) => {
        console.error(
          `reports: schedule failed: ${err instanceof Error ? err.message : "unknown"}`,
        );
      })
      .finally(() => {
        running = null;
      });
  };

  // First check an hour after boot, then every 24 h (same spirit as expiry scheduler).
  const first = setTimeout(tick, 60 * 60_000);
  const interval = setInterval(tick, DAY_MS);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(interval);
  };
}
