// Daily vulnerability feed sync (Phase 2 step 2, A132). In-process, like the deploy
// orchestrator (A82): the API runs as one process, so a timer is enough.
import { readFeedStatus, syncVulnerabilities, type VulnDeps } from "./service";

const HOUR = 60 * 60_000;
/** Sync when the last success is older than this. */
export const SYNC_EVERY_MS = 24 * HOUR;
/** After a failed attempt, wait this long before the next try (no audit spam every hour). */
export const RETRY_AFTER_FAILURE_MS = 6 * HOUR;

/** True when the schedule should sync now. */
export function syncDue(
  status: { lastSuccessAt: string | null; lastAttemptAt: string | null; ok: boolean | null },
  now: Date,
): boolean {
  const t = now.getTime();
  const success = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : null;
  if (success !== null && t - success < SYNC_EVERY_MS) return false;
  const attempt = status.lastAttemptAt ? Date.parse(status.lastAttemptAt) : null;
  if (attempt !== null && status.ok === false && t - attempt < RETRY_AFTER_FAILURE_MS) return false;
  return true;
}

/** Checks hourly (first check after `firstDelayMs`); returns a stop function. */
export function startVulnScheduler(
  deps: VulnDeps,
  opts: { firstDelayMs?: number; intervalMs?: number } = {},
): () => void {
  const tick = async () => {
    try {
      const status = await readFeedStatus(deps.db);
      if (status.running || !syncDue(status, deps.now())) return;
      await syncVulnerabilities(deps, { userId: null, ip: null });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "vuln_schedule_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  const first = setTimeout(() => void tick(), opts.firstDelayMs ?? 2 * 60_000);
  const every = setInterval(() => void tick(), opts.intervalMs ?? HOUR);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
