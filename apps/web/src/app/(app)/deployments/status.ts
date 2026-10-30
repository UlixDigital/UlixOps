import type { DeploymentStatus, TargetStatus } from "@ulixops/shared";

export const STATUS_TONE: Record<DeploymentStatus, string> = {
  PENDING_APPROVAL: "bg-warning/10 text-warning",
  QUEUED: "bg-muted text-muted-foreground",
  RUNNING: "bg-primary/10 text-primary",
  PAUSED: "bg-warning/10 text-warning",
  SUCCEEDED: "bg-success/10 text-success",
  FAILED: "bg-destructive/10 text-destructive",
  CANCELLED: "bg-muted text-muted-foreground",
};

export const TARGET_TONE: Record<TargetStatus, string> = {
  QUEUED: "bg-muted text-muted-foreground",
  SNAPSHOT: "bg-primary/10 text-primary",
  STAGING: "bg-primary/10 text-primary",
  DEPLOYING: "bg-primary/10 text-primary",
  CHECKING: "bg-primary/10 text-primary",
  DONE: "bg-success/10 text-success",
  ROLLED_BACK: "bg-warning/10 text-warning",
  FAILED: "bg-destructive/10 text-destructive",
  PAUSED: "bg-warning/10 text-warning",
};
