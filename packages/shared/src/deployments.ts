// Deploy wizard + live view contracts (Build Order step 10, spec §6.4).
import { z } from "zod";
import { EnvKind } from "./sites";
import { RecordId } from "./users";

const iso = z.iso.datetime();

export const DeploymentStatus = z.enum([
  "PENDING_APPROVAL",
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

/** Per-target step names match the live view (spec screen 10). */
export const TargetStatus = z.enum([
  "QUEUED",
  "SNAPSHOT",
  "STAGING",
  "CHECKING",
  "DEPLOYING",
  "DONE",
  "ROLLED_BACK",
  "FAILED",
  "PAUSED",
]);
export type TargetStatus = z.infer<typeof TargetStatus>;

export const CreateDeploymentRequest = z.object({
  pluginSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  version: z.string().regex(/^[0-9a-zA-Z][0-9a-zA-Z.-]{0,29}$/),
  siteIds: z.array(RecordId).min(1).max(100),
  stagingFirst: z.boolean().default(true),
  batchSize: z.number().int().min(1).max(10).default(2),
  pauseOnFailure: z.boolean().default(true),
});
export type CreateDeploymentRequest = z.infer<typeof CreateDeploymentRequest>;

export const DeploymentTargetView = z.object({
  id: RecordId,
  siteId: RecordId,
  siteName: z.string(),
  kind: EnvKind,
  status: TargetStatus,
  log: z.string(),
  backupId: RecordId.nullable(),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});
export type DeploymentTargetView = z.infer<typeof DeploymentTargetView>;

export const DeploymentView = z.object({
  id: RecordId,
  status: DeploymentStatus,
  pluginSlug: z.string(),
  pluginName: z.string(),
  version: z.string(),
  stagingFirst: z.boolean(),
  batchSize: z.number().int(),
  pauseOnFailure: z.boolean(),
  requestedBy: z.object({ id: RecordId, email: z.string() }).nullable(),
  approvedBy: z.object({ id: RecordId, email: z.string() }).nullable(),
  approvalId: RecordId.nullable(),
  createdAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  targets: z.array(DeploymentTargetView),
});
export type DeploymentView = z.infer<typeof DeploymentView>;

export const DeploymentList = z.object({
  deployments: z.array(DeploymentView),
});
export type DeploymentList = z.infer<typeof DeploymentList>;

/** GET /deployments: newest first; `siteId` keeps rollouts that touched that site. */
export const DeploymentListQuery = z.object({
  siteId: RecordId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
export type DeploymentListQuery = z.infer<typeof DeploymentListQuery>;

export const CreateDeploymentResponse = z.object({
  deployment: DeploymentView,
  /** When set, the rollout waits for another Admin on the Approvals screen. */
  approvalId: RecordId.nullable(),
});
export type CreateDeploymentResponse = z.infer<typeof CreateDeploymentResponse>;

export const DeploymentResponse = z.object({
  deployment: DeploymentView,
});
export type DeploymentResponse = z.infer<typeof DeploymentResponse>;

/** Bulk / all-sites production rollout needs a second Admin (spec §5). */
export function deploymentNeedsApproval(productionSiteCount: number): boolean {
  return productionSiteCount > 1;
}
