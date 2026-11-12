// File integrity monitoring (Phase 2 step 4, A144): WordPress core and WordPress.org plugins
// checked against the official checksums with WP-CLI, over SSH. Read-only on the site.
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();
const Env = z.enum(["PRODUCTION", "STAGING"]);

export const IntegrityScope = z.enum(["core", "plugin"]);
export type IntegrityScope = z.infer<typeof IntegrityScope>;
/** modified: content differs; added: a file the release doesn't have; missing: deleted. */
export const IntegrityIssue = z.enum(["modified", "added", "missing"]);
export type IntegrityIssue = z.infer<typeof IntegrityIssue>;

/**
 * One changed file, as the runner reports it. `component` is "wordpress" (path from the site
 * root) or a plugin slug (path within that plugin).
 */
export const IntegrityFinding = z.object({
  scope: IntegrityScope,
  component: z.string().min(1).max(200),
  path: z.string().min(1).max(1000),
  issue: IntegrityIssue,
});
export type IntegrityFinding = z.infer<typeof IntegrityFinding>;

export const MAX_INTEGRITY_FINDINGS = 2000;

/** `site.integrity` result. */
export const IntegrityJobResult = z.discriminatedUnion("hostKeyMismatch", [
  z.object({ hostKeyMismatch: z.literal(true), presented: z.string() }),
  z.object({
    hostKeyMismatch: z.literal(false),
    hostKey: z.string(),
    /** The core check ran (it works even when WordPress is broken). */
    coreChecked: z.boolean(),
    /** The plugin check ran (needs WordPress to load). */
    pluginsChecked: z.boolean(),
    verifiedPlugins: z.number().int().nonnegative(),
    /** Plugins WordPress.org has no checksums for (premium, custom): not verifiable. */
    unverifiable: z.array(z.string().max(200)).max(1000),
    findings: z.array(IntegrityFinding).max(MAX_INTEGRITY_FINDINGS),
    /** Plain-language summary, redacted. */
    detail: z.string().max(2000),
    durationMs: z.number(),
  }),
]);
export type IntegrityJobResult = z.infer<typeof IntegrityJobResult>;

// ---- Views ---------------------------------------------------------------------------------

export const IntegrityStatus = z.enum(["RUNNING", "CLEAN", "CHANGED", "FAILED"]);
export type IntegrityStatus = z.infer<typeof IntegrityStatus>;

export const IntegrityFindingView = IntegrityFinding.extend({ id, ignored: z.boolean() });
export type IntegrityFindingView = z.infer<typeof IntegrityFindingView>;

export const IntegrityCheckView = z.object({
  id,
  siteId: id,
  siteName: z.string(),
  environment: Env,
  status: IntegrityStatus,
  startedAt: iso,
  finishedAt: iso.nullable(),
  /** Email of who asked for it; null for the schedule. */
  requestedBy: z.string().nullable(),
  detail: z.string().nullable(),
  coreChecked: z.boolean(),
  pluginsChecked: z.boolean(),
  verifiedPlugins: z.number().int().nonnegative(),
  unverifiable: z.array(z.string()),
  /** Changes that are not known-safe. */
  findingCount: z.number().int().nonnegative(),
  /** Empty in list views. */
  findings: z.array(IntegrityFindingView),
});
export type IntegrityCheckView = z.infer<typeof IntegrityCheckView>;

export const IntegrityCheckList = z.object({ checks: z.array(IntegrityCheckView) });
export type IntegrityCheckList = z.infer<typeof IntegrityCheckList>;

export const IntegrityIgnoreView = z.object({
  id,
  scope: IntegrityScope,
  component: z.string(),
  path: z.string(),
  reason: z.string(),
  createdBy: z.string().nullable(),
  createdAt: iso,
});
export type IntegrityIgnoreView = z.infer<typeof IntegrityIgnoreView>;

export const IntegrityCheckDetail = z.object({
  check: IntegrityCheckView,
  ignores: z.array(IntegrityIgnoreView),
});
export type IntegrityCheckDetail = z.infer<typeof IntegrityCheckDetail>;

export const IntegritySiteRow = z.object({
  siteId: id,
  siteName: z.string(),
  environment: Env,
  ready: z.boolean(),
  autoScan: z.boolean(),
  last: z
    .object({
      id,
      status: IntegrityStatus,
      at: iso,
      findingCount: z.number().int().nonnegative(),
      unverifiable: z.number().int().nonnegative(),
    })
    .nullable(),
  running: id.nullable(),
});
export type IntegritySiteRow = z.infer<typeof IntegritySiteRow>;

export const IntegrityOverview = z.object({
  /** Daily checks run with the malware scan schedule's window and site switches. */
  automatic: z.boolean(),
  sites: z.array(IntegritySiteRow),
  stats: z.object({
    changed: z.number().int(),
    clean: z.number().int(),
    failed: z.number().int(),
    neverChecked: z.number().int(),
    lastFinishedAt: iso.nullable(),
  }),
});
export type IntegrityOverview = z.infer<typeof IntegrityOverview>;

export const INTEGRITY_ISSUE_LABELS: Record<IntegrityIssue, string> = {
  modified: "Modified",
  added: "Added (not in the release)",
  missing: "Missing",
};
