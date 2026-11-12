// Scheduled updates (Phase 4 step 2, A162): a weekly window per site in which patch and minor
// plugin / theme updates and WordPress maintenance releases install unattended, staging first,
// each with a snapshot, a health check and a rollback. Majors are only listed.
import { z } from "zod";
import { PluginName } from "./commands";
import { SnapshotAsset, type VersionJumpSafety, versionJumpSafety } from "./snapshots";
import { RecordId } from "./users";

const HOUR = 60 * 60_000;
const WEEK = 7 * 24 * HOUR;
/** A window missed (API down, site busy) is still started up to this long after it opens. */
export const AUTOUPDATE_GRACE_MS = 3 * HOUR;

export const AutoUpdateAsset = z.enum(["plugin", "theme", "core"]);
export type AutoUpdateAsset = z.infer<typeof AutoUpdateAsset>;

/** Plugins / themes that are never updated automatically on this site. */
export const AutoUpdateSkip = z.object({ asset: SnapshotAsset, name: PluginName });
export type AutoUpdateSkip = z.infer<typeof AutoUpdateSkip>;
export const AutoUpdateSkipList = z.array(AutoUpdateSkip).max(200);

/** A version that failed and was rolled back: not tried again until a newer one appears. */
export const AutoUpdateHold = z.object({
  asset: AutoUpdateAsset,
  name: z.string().min(1).max(100),
  version: z.string().max(50),
  at: z.string(),
  reason: z.string().max(500),
});
export type AutoUpdateHold = z.infer<typeof AutoUpdateHold>;
export const AutoUpdateHoldList = z.array(AutoUpdateHold).max(500);

export const AutoUpdateWindow = z.object({
  /** 0 = Sunday … 6 = Saturday (UTC). */
  dayOfWeek: z.number().int().min(0).max(6),
  hourUtc: z.number().int().min(0).max(23),
});
export type AutoUpdateWindow = z.infer<typeof AutoUpdateWindow>;

export const DEFAULT_AUTOUPDATE_WINDOW: AutoUpdateWindow = { dayOfWeek: 2, hourUtc: 6 };

/** PUT /sites/:id/auto-updates: window and skip list (switching on goes through approval). */
export const AutoUpdateSettingsRequest = AutoUpdateWindow.extend({ skip: AutoUpdateSkipList });
export type AutoUpdateSettingsRequest = z.infer<typeof AutoUpdateSettingsRequest>;

/** POST /auto-updates/enable: switch on for one or more sites (always an ApprovalRequest). */
export const AutoUpdateEnableRequest = z.object({
  siteIds: z.array(RecordId).min(1).max(200),
  /** Window for sites that have none yet; sites with saved settings keep theirs. */
  window: AutoUpdateWindow.optional(),
});
export type AutoUpdateEnableRequest = z.infer<typeof AutoUpdateEnableRequest>;

export const AutoUpdateHoldClearRequest = z.object({
  asset: AutoUpdateAsset,
  name: z.string().min(1).max(100),
});

// ---- Window maths ----------------------------------------------------------------------------

/** Start of the most recent window at or before `now`. */
export function autoUpdateWindowStart(w: AutoUpdateWindow, now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(w.hourUtc, 0, 0, 0);
  const back = (now.getUTCDay() - w.dayOfWeek + 7) % 7;
  start.setUTCDate(start.getUTCDate() - back);
  if (start.getTime() > now.getTime()) return new Date(start.getTime() - WEEK);
  return start;
}

export function nextAutoUpdateWindow(w: AutoUpdateWindow, now: Date): Date {
  return new Date(autoUpdateWindowStart(w, now).getTime() + WEEK);
}

/** Due when the current window opened less than the grace period ago and hasn't run yet. */
export function autoUpdateDue(
  s: AutoUpdateWindow & { enabled: boolean; lastWindowAt: Date | null },
  now: Date,
): boolean {
  if (!s.enabled) return false;
  const start = autoUpdateWindowStart(s, now);
  if (now.getTime() - start.getTime() >= AUTOUPDATE_GRACE_MS) return false;
  return !s.lastWindowAt || s.lastWindowAt.getTime() < start.getTime();
}

// ---- Planning --------------------------------------------------------------------------------

/**
 * WordPress numbers releases x.y (major) and x.y.z (maintenance), so 6.8 → 6.9 is a major
 * release even though semver would call it minor. Only same-branch maintenance releases are
 * automatic (WordPress's own default).
 */
export function coreAutoSafe(from: string, to: string): boolean {
  const a = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(from.trim());
  const b = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(to.trim());
  if (!a || !b || a[1] !== b[1] || a[2] !== b[2]) return false;
  return Number(b[3] ?? 0) > Number(a[3] ?? 0);
}

export type AutoUpdateCandidate = {
  asset: AutoUpdateAsset;
  name: string;
  version: string;
  updateVersion: string;
  safety: VersionJumpSafety;
};

export const AutoUpdateSkipReason = z.enum([
  "skip_list",
  "held",
  "not_tested_on_staging",
  "staging_failed",
]);
export type AutoUpdateSkipReason = z.infer<typeof AutoUpdateSkipReason>;

export type AutoUpdatePlan = {
  /** Installed automatically, plugins and themes first, core last. */
  auto: AutoUpdateCandidate[];
  /** Majors (and versions we can't classify): listed for a manual update. */
  manual: AutoUpdateCandidate[];
  skipped: (AutoUpdateCandidate & { reason: AutoUpdateSkipReason })[];
};

type InvItem = { name: string; version: string; updateVersion: string | null };

const keyOf = (c: { asset: string; name: string }) => `${c.asset}:${c.name}`;

/**
 * What a scheduled run installs on one environment. `verified` (production after a staging run)
 * limits automatic items to the exact versions staging is now running healthily.
 */
export function planAutoUpdates(
  inv: {
    plugins: InvItem[];
    themes: InvItem[];
    wpVersion: string | null;
    coreUpdateVersion: string | null;
  },
  opts: {
    skip: AutoUpdateSkip[];
    holds: AutoUpdateHold[];
    verified?: Set<string> | null;
  },
): AutoUpdatePlan {
  const skip = new Set(opts.skip.map(keyOf));
  const plan: AutoUpdatePlan = { auto: [], manual: [], skipped: [] };
  const candidates: AutoUpdateCandidate[] = [
    ...(["plugin", "theme"] as const).flatMap((asset) =>
      (asset === "plugin" ? inv.plugins : inv.themes)
        .filter((i) => i.updateVersion && i.updateVersion !== i.version)
        .map((i) => ({
          asset,
          name: i.name,
          version: i.version,
          updateVersion: i.updateVersion ?? "",
          safety: versionJumpSafety(i.version, i.updateVersion ?? ""),
        })),
    ),
  ];
  if (inv.wpVersion && inv.coreUpdateVersion && inv.coreUpdateVersion !== inv.wpVersion) {
    const safe = coreAutoSafe(inv.wpVersion, inv.coreUpdateVersion);
    candidates.push({
      asset: "core",
      name: "wordpress",
      version: inv.wpVersion,
      updateVersion: inv.coreUpdateVersion,
      safety: safe ? "patch" : "major",
    });
  }
  for (const c of candidates) {
    if (c.asset !== "core" && skip.has(keyOf(c))) {
      plan.skipped.push({ ...c, reason: "skip_list" });
    } else if (c.safety === "major" || c.safety === "unknown") {
      plan.manual.push(c);
    } else if (
      opts.holds.some(
        (h) => h.asset === c.asset && h.name === c.name && h.version === c.updateVersion,
      )
    ) {
      plan.skipped.push({ ...c, reason: "held" });
    } else if (opts.verified && !opts.verified.has(verifiedKey(c))) {
      plan.skipped.push({ ...c, reason: "not_tested_on_staging" });
    } else {
      plan.auto.push(c);
    }
  }
  plan.auto.sort((a, b) => Number(a.asset === "core") - Number(b.asset === "core"));
  return plan;
}

/** "plugin:akismet@5.3.1": an exact version staging is running. */
export function verifiedKey(c: { asset: string; name: string; updateVersion: string }): string {
  return `${keyOf(c)}@${c.updateVersion}`;
}

/** Every version an environment runs, for checking production items against staging. */
export function verifiedVersions(inv: {
  plugins: InvItem[];
  themes: InvItem[];
  wpVersion: string | null;
}): Set<string> {
  const out = new Set<string>();
  for (const p of inv.plugins)
    out.add(verifiedKey({ asset: "plugin", name: p.name, updateVersion: p.version }));
  for (const t of inv.themes)
    out.add(verifiedKey({ asset: "theme", name: t.name, updateVersion: t.version }));
  if (inv.wpVersion)
    out.add(verifiedKey({ asset: "core", name: "wordpress", updateVersion: inv.wpVersion }));
  return out;
}

/** Drop holds whose version is no longer the one offered (a newer one appeared, or it's gone). */
export function pruneHolds(
  holds: AutoUpdateHold[],
  offered: AutoUpdateCandidate[],
): AutoUpdateHold[] {
  return holds.filter((h) =>
    offered.some((c) => c.asset === h.asset && c.name === h.name && c.updateVersion === h.version),
  );
}

// ---- Run reports and views -------------------------------------------------------------------

export const AutoUpdateOutcome = z.enum(["updated", "rolled_back", "failed", "not_run", "skipped"]);
export type AutoUpdateOutcome = z.infer<typeof AutoUpdateOutcome>;

export const AutoUpdateItemReport = z.object({
  asset: AutoUpdateAsset,
  name: z.string(),
  version: z.string(),
  updateVersion: z.string(),
  safety: z.enum(["patch", "minor", "major", "unknown"]),
  outcome: AutoUpdateOutcome,
  detail: z.string().max(2000),
});
export type AutoUpdateItemReport = z.infer<typeof AutoUpdateItemReport>;

export const AutoUpdateEnvReport = z.object({
  kind: z.enum(["PRODUCTION", "STAGING"]),
  /** False when nothing was installed here (busy, unhealthy before, staging failed…). */
  ran: z.boolean(),
  detail: z.string().max(2000),
  items: z.array(AutoUpdateItemReport),
});
export type AutoUpdateEnvReport = z.infer<typeof AutoUpdateEnvReport>;

export const AutoUpdateRunStatus = z.enum([
  "running",
  "completed",
  "nothing_to_do",
  "problems",
  "interrupted",
]);
export type AutoUpdateRunStatus = z.infer<typeof AutoUpdateRunStatus>;

export const AutoUpdateRunView = z.object({
  id: z.string(),
  windowAt: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: AutoUpdateRunStatus,
  environments: z.array(AutoUpdateEnvReport),
  /** Majors waiting for a manual update when the run planned. */
  manual: z.array(AutoUpdateItemReport),
  updated: z.number().int(),
  problems: z.number().int(),
});
export type AutoUpdateRunView = z.infer<typeof AutoUpdateRunView>;

export const AutoUpdateView = z.object({
  siteId: z.string(),
  enabled: z.boolean(),
  window: AutoUpdateWindow,
  skip: AutoUpdateSkipList,
  holds: AutoUpdateHoldList,
  /** Waiting for a second Admin to approve switching on. */
  pendingApprovalId: z.string().nullable(),
  nextWindowAt: z.string().nullable(),
  hasStaging: z.boolean(),
  enabledAt: z.string().nullable(),
  runs: z.array(AutoUpdateRunView),
});
export type AutoUpdateView = z.infer<typeof AutoUpdateView>;

export const AutoUpdateOverviewRow = z.object({
  siteId: z.string(),
  siteName: z.string(),
  enabled: z.boolean(),
  window: AutoUpdateWindow.nullable(),
  pendingApproval: z.boolean(),
  nextWindowAt: z.string().nullable(),
  hasStaging: z.boolean(),
  lastRun: AutoUpdateRunView.pick({
    startedAt: true,
    status: true,
    updated: true,
    problems: true,
  }).nullable(),
  holds: z.number().int(),
});
export type AutoUpdateOverviewRow = z.infer<typeof AutoUpdateOverviewRow>;

export const AutoUpdateOverview = z.object({
  rows: z.array(AutoUpdateOverviewRow),
  running: z.boolean(),
});
export type AutoUpdateOverview = z.infer<typeof AutoUpdateOverview>;

export const AUTOUPDATE_STATUS_LABELS: Record<AutoUpdateRunStatus, string> = {
  running: "Running",
  completed: "Updated",
  nothing_to_do: "Nothing to update",
  problems: "Problems",
  interrupted: "Interrupted",
};

export const AUTOUPDATE_SKIP_LABELS: Record<AutoUpdateSkipReason, string> = {
  skip_list: "On the skip list",
  held: "Held: this version was rolled back before",
  not_tested_on_staging: "Not tested on staging",
  staging_failed: "Staging had problems",
};
