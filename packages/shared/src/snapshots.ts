// Quick pre-update snapshots (Build Order step 8, spec §6.5).
import { z } from "zod";
import { CoreVersion, PluginName, ThemeName } from "./commands";
import { EnvKind, SiteActionResponse, SiteJobView } from "./sites";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();

export const BackupKind = z.enum(["QUICK_SNAPSHOT", "FULL"]);
export type BackupKind = z.infer<typeof BackupKind>;

export const BackupStatus = z.enum(["PENDING", "READY", "FAILED", "EXPIRED"]);
export type BackupStatus = z.infer<typeof BackupStatus>;

/** Plugin folder vs theme folder under wp-content (A104). */
export const SnapshotAsset = z.enum(["plugin", "theme"]);
export type SnapshotAsset = z.infer<typeof SnapshotAsset>;

/** Default retention when the Setting row is missing (spec §6.5 / SNAPSHOT_RETENTION_DAYS). */
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 7;
export const MIN_SNAPSHOT_RETENTION_DAYS = 1;
export const MAX_SNAPSHOT_RETENTION_DAYS = 90;

export const SnapshotRetentionSetting = z.object({
  days: z.number().int().min(MIN_SNAPSHOT_RETENTION_DAYS).max(MAX_SNAPSHOT_RETENTION_DAYS),
});
export type SnapshotRetentionSetting = z.infer<typeof SnapshotRetentionSetting>;

export const CreateSnapshotRequest = z.object({
  plugin: PluginName,
  /** Also export the database into the snapshot (DB-changing / major updates). */
  includeDb: z.boolean().default(false),
  asset: SnapshotAsset.default("plugin"),
});
export type CreateSnapshotRequest = z.infer<typeof CreateSnapshotRequest>;

export const UpdatePluginRequest = z.object({
  plugin: PluginName,
  /**
   * Force a DB export into the pre-update snapshot. When omitted, the API includes the DB for a
   * major version bump (first number changes) automatically.
   */
  includeDb: z.boolean().optional(),
});
export type UpdatePluginRequest = z.infer<typeof UpdatePluginRequest>;

export const UpdateThemeRequest = z.object({
  theme: ThemeName,
  includeDb: z.boolean().optional(),
});
export type UpdateThemeRequest = z.infer<typeof UpdateThemeRequest>;

/** Delete an inactive plugin or theme after snapshotting its folder (A137). */
export const DeletePluginRequest = z.object({ plugin: PluginName });
export const DeleteThemeRequest = z.object({ theme: ThemeName });

/** Update WordPress core to the release the last update check offered (A135). */
export const UpdateCoreRequest = z.object({ version: CoreVersion });

export const CoreUpdateResponse = z.object({
  /** updated: healthy on the new version. rolled_back: health failed, previous version restored. */
  status: z.enum(["updated", "failed", "rolled_back", "rollback_failed"]),
  fromVersion: z.string(),
  toVersion: z.string(),
  detail: z.string().max(2000),
  jobs: z.array(SiteJobView),
});
export type CoreUpdateResponse = z.infer<typeof CoreUpdateResponse>;

/** Backup strategy before a bulk environment update (A104). Drive is UI-only until Phase 2. */
export const BulkUpdateStrategy = z.enum(["snapshots", "google_drive"]);
export type BulkUpdateStrategy = z.infer<typeof BulkUpdateStrategy>;

/** How risky the version jump looks for the review UI (A108). */
export const VersionJumpSafety = z.enum(["patch", "minor", "major", "unknown"]);
export type VersionJumpSafety = z.infer<typeof VersionJumpSafety>;

export const BulkUpdateItem = z.object({
  asset: SnapshotAsset,
  name: z.union([PluginName, ThemeName]),
});
export type BulkUpdateItem = z.infer<typeof BulkUpdateItem>;

/** Planned row shown in requester/approver review (versions from inventory). */
export const BulkUpdatePlanItem = z.object({
  asset: SnapshotAsset,
  name: z.union([PluginName, ThemeName]),
  version: z.string().max(50),
  updateVersion: z.string().max(50),
  safety: VersionJumpSafety,
});
export type BulkUpdatePlanItem = z.infer<typeof BulkUpdatePlanItem>;

export const BulkUpdateRequest = z.object({
  strategy: BulkUpdateStrategy,
  /**
   * Subset of outdated items to update. Prefer full plan rows (with versions); name+asset
   * alone is enough — the API fills versions from inventory.
   */
  items: z
    .array(
      z.object({
        asset: SnapshotAsset,
        name: z.union([PluginName, ThemeName]),
        version: z.string().max(50).optional(),
        updateVersion: z.string().max(50).optional(),
        safety: VersionJumpSafety.optional(),
      }),
    )
    .max(200)
    .optional(),
});
export type BulkUpdateRequest = z.infer<typeof BulkUpdateRequest>;

export const BulkUpdateItemResult = z.object({
  asset: SnapshotAsset,
  name: z.string(),
  status: z.enum(["succeeded", "failed", "skipped", "rolled_back"]),
  detail: z.string().max(2000),
  backupId: id.nullable(),
  fromVersion: z.string().optional(),
  toVersion: z.string().optional(),
  safety: VersionJumpSafety.optional(),
  rolledBack: z.boolean().optional(),
});
export type BulkUpdateItemResult = z.infer<typeof BulkUpdateItemResult>;

export const BulkUpdateStepName = z.enum(["snapshot", "update", "health", "rollback"]);
export type BulkUpdateStepName = z.infer<typeof BulkUpdateStepName>;

export const BulkUpdateRunStep = z.object({
  step: BulkUpdateStepName,
  ok: z.boolean(),
  detail: z.string().max(2000),
  at: iso,
});
export type BulkUpdateRunStep = z.infer<typeof BulkUpdateRunStep>;

export const BulkUpdateRunItemProgress = z.object({
  asset: SnapshotAsset,
  name: z.string(),
  version: z.string(),
  updateVersion: z.string(),
  safety: VersionJumpSafety,
  outcome: z.enum(["pending", "running", "succeeded", "failed", "rolled_back"]),
  steps: z.array(BulkUpdateRunStep),
  backupId: id.nullable().optional(),
});
export type BulkUpdateRunItemProgress = z.infer<typeof BulkUpdateRunItemProgress>;

export const BulkUpdateRunProgress = z.object({
  updatedAt: iso,
  phase: z.enum(["pre_health", "items", "done"]),
  current: z
    .object({
      index: z.number().int().nonnegative(),
      total: z.number().int().positive(),
      asset: SnapshotAsset,
      name: z.string(),
      step: BulkUpdateStepName,
    })
    .nullable(),
  preHealth: z
    .object({
      ok: z.boolean(),
      summary: z.string().max(2000),
      checkedAt: iso,
    })
    .nullable(),
  items: z.array(BulkUpdateRunItemProgress),
  reportMarkdown: z.string().max(50_000).nullable(),
});
export type BulkUpdateRunProgress = z.infer<typeof BulkUpdateRunProgress>;

export const BulkUpdateResponse = z.object({
  /** Present when production bulk is waiting for a second Admin (A104). */
  approvalId: id.nullable(),
  status: z.enum(["completed", "pending_approval", "rejected_strategy", "running"]),
  results: z.array(BulkUpdateItemResult),
  inventoryRefreshed: z.boolean(),
  reportMarkdown: z.string().max(50_000).optional(),
});
export type BulkUpdateResponse = z.infer<typeof BulkUpdateResponse>;

/** Pollable status for a live / recent bulk run on one environment (A108). */
export const BulkUpdateStatusResponse = z.object({
  active: z.boolean(),
  approvalId: id.nullable(),
  runStatus: z.enum(["pending_approval", "queued", "running", "completed", "failed"]).nullable(),
  progress: BulkUpdateRunProgress.nullable(),
  reportMarkdown: z.string().max(50_000).nullable(),
});
export type BulkUpdateStatusResponse = z.infer<typeof BulkUpdateStatusResponse>;

export const BackupView = z.object({
  id,
  siteId: id,
  siteName: z.string(),
  kind: BackupKind,
  status: BackupStatus,
  environment: EnvKind,
  pluginName: z.string().nullable(),
  pluginVersion: z.string().nullable(),
  includesDb: z.boolean(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  encrypted: z.boolean(),
  expiresAt: iso.nullable(),
  createdAt: iso,
  restoredAt: iso.nullable(),
  createdBy: z.object({ id, email: z.string() }).nullable(),
});
export type BackupView = z.infer<typeof BackupView>;

export const BackupList = z.object({ backups: z.array(BackupView) });
export const BackupResponse = z.object({ backup: BackupView });

export const SnapshotActionResponse = SiteActionResponse.extend({
  backup: BackupView.nullable(),
});
export type SnapshotActionResponse = z.infer<typeof SnapshotActionResponse>;

/** Update-plugin response: the pre-update snapshot plus the update job. */
export const PluginUpdateResponse = SiteActionResponse.extend({
  backup: BackupView.nullable(),
  updateJob: SiteJobView.nullable(),
});
export type PluginUpdateResponse = z.infer<typeof PluginUpdateResponse>;

export const ThemeUpdateResponse = PluginUpdateResponse;
export type ThemeUpdateResponse = z.infer<typeof ThemeUpdateResponse>;

/** First numeric component differs → major bump (e.g. 1.9 → 2.0). */
export function isMajorVersionBump(from: string, to: string): boolean {
  const a = /^(\d+)/.exec(from.trim())?.[1];
  const b = /^(\d+)/.exec(to.trim())?.[1];
  return a !== undefined && b !== undefined && a !== b;
}

function semverTriple(v: string): [number, number, number] | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Classify a version jump for the bulk-update review UI (A108). */
export function versionJumpSafety(from: string, to: string): VersionJumpSafety {
  const a = semverTriple(from);
  const b = semverTriple(to);
  if (!a || !b) return "unknown";
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return "patch";
}
