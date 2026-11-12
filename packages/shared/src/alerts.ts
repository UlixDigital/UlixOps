// Alert follow-up (agent decision A158): every notification belongs to one Alert, which tracks
// who saw it, who took it, what they did and whether the fix held. Super Admins see the report.
import { z } from "zod";
import { NotificationEvent, NotificationSeverity } from "./notifications";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();

export const AlertStatus = z.enum([
  /** Informational event: tracked for "seen" only, nothing to fix. */
  "INFO",
  "OPEN",
  /** Someone said "I'm on it" (they are the owner). */
  "ACKNOWLEDGED",
  /** The owner says it is fixed; waits for the system or a Super Admin to confirm. */
  "RESOLVED",
  /** The fix was confirmed (by a later clean check or a Super Admin). Closed. */
  "VERIFIED",
  /** The problem went away before anyone claimed a fix. Closed, nobody credited. */
  "AUTO_CLEARED",
]);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const CLOSED_ALERT_STATUSES: readonly AlertStatus[] = ["INFO", "VERIFIED", "AUTO_CLEARED"];

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  INFO: "Info",
  OPEN: "Open",
  ACKNOWLEDGED: "In progress",
  RESOLVED: "Fixed, awaiting check",
  VERIFIED: "Fix confirmed",
  AUTO_CLEARED: "Cleared on its own",
};

export const AlertResolution = z.enum(["FIXED", "FALSE_POSITIVE", "NO_ACTION_NEEDED"]);
export type AlertResolution = z.infer<typeof AlertResolution>;

export const ALERT_RESOLUTION_LABELS: Record<AlertResolution, string> = {
  FIXED: "Fixed",
  FALSE_POSITIVE: "False alarm",
  NO_ACTION_NEEDED: "Expected / no action needed",
};

export const FixAction = z.enum([
  "removed_malware",
  "updated_software",
  "restored_backup",
  "rolled_back",
  "fixed_hosting",
  "fixed_dns_ssl",
  "config_change",
  "contacted_vendor",
  "security_review",
  "marked_known_safe",
  "approval_decided",
  "other",
]);
export type FixAction = z.infer<typeof FixAction>;

export const FIX_ACTION_LABELS: Record<FixAction, string> = {
  removed_malware: "Removed or cleaned the infected files",
  updated_software: "Updated a plugin, theme or WordPress",
  restored_backup: "Restored from a backup or snapshot",
  rolled_back: "Rolled back a deployment",
  fixed_hosting: "Fixed it at the host (WP Engine, PHP, cache, server)",
  fixed_dns_ssl: "Fixed DNS, SSL or the domain",
  config_change: "Changed site or hub settings",
  contacted_vendor: "Contacted the host, vendor or client",
  security_review: "Checked the account / sign-in and secured it",
  marked_known_safe: "Confirmed the files are legitimate (known-safe)",
  approval_decided: "Decided the approval request",
  other: "Something else (described in the note)",
};

/** Events with nothing to fix: they are tracked for "seen" only. */
export const INFO_ALERT_KINDS: readonly NotificationEvent[] = [
  "deployment.started",
  "deployment.succeeded",
  "bulk_update.completed",
  "restore.succeeded",
  "uptime.up",
  /** Awareness only — expected when you sign in from a new browser/device (A175). */
  "security.NEW_DEVICE_LOGIN",
  /** Monthly report ready — download, not a problem to fix (A176). */
  "report.ready",
  /** Audit trail that a Super Admin self-approved; not a ticket (A176). */
  "approval.self_approved",
];

/**
 * Kinds the hub re-checks by itself: a later clean check confirms a claimed fix, a later
 * failing check rejects it. The rest need a Super Admin to confirm.
 */
export const AUTO_VERIFIED_ALERT_KINDS: readonly NotificationEvent[] = [
  "uptime.down",
  "malware.found",
  "integrity.changed",
  "backup.failed",
  "backup.skipped",
  "restore.failed",
  "ssl.expiring",
  "ssl.invalid",
  "domain.expiring",
  "approval.requested",
];

/** A notification of the key kind is the "all clear" for the listed problem kinds. */
export const RECOVERY_ALERT_KINDS: Partial<Record<NotificationEvent, NotificationEvent[]>> = {
  "uptime.up": ["uptime.down"],
  "restore.succeeded": ["restore.failed"],
};

export function isActionableKind(kind: string): boolean {
  return !(INFO_ALERT_KINDS as readonly string[]).includes(kind);
}

export function isAutoVerifiedKind(kind: string): boolean {
  return (AUTO_VERIFIED_ALERT_KINDS as readonly string[]).includes(kind);
}

// ---- State machine --------------------------------------------------------------------------

export type AlertAction =
  /** A member takes the alert ("I'm on it"); may take it over from another owner. */
  | "acknowledge"
  /** The owner (or any recipient) says it is fixed / a false alarm. */
  | "resolve"
  /** Super Admin or a clean check confirms the claimed fix. */
  | "confirm"
  /** Super Admin or a failing check says the claimed fix did not work. */
  | "reject"
  /** The problem fired again. */
  | "recur"
  /** A clean check arrived. */
  | "clear"
  /** Super Admin reopens a closed alert. */
  | "reopen";

/** The next status, or null when the action is not allowed from `status`. */
export function alertTransition(status: AlertStatus, action: AlertAction): AlertStatus | null {
  if (status === "INFO") return null;
  switch (action) {
    case "acknowledge":
      return status === "OPEN" || status === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : null;
    case "resolve":
      return status === "OPEN" || status === "ACKNOWLEDGED" ? "RESOLVED" : null;
    case "confirm":
      return status === "RESOLVED" ? "VERIFIED" : null;
    case "reject":
      return status === "RESOLVED" ? "OPEN" : null;
    case "recur":
      if (status === "OPEN" || status === "ACKNOWLEDGED") return status;
      return status === "RESOLVED" ? "OPEN" : null;
    case "clear":
      if (status === "OPEN" || status === "ACKNOWLEDGED") return "AUTO_CLEARED";
      return status === "RESOLVED" ? "VERIFIED" : null;
    case "reopen":
      return status === "VERIFIED" || status === "AUTO_CLEARED" ? "OPEN" : null;
  }
}

// ---- Timeline -------------------------------------------------------------------------------

export const AlertEventType = z.enum([
  "RAISED",
  "REPEATED",
  "SEEN",
  "READ",
  "ACKNOWLEDGED",
  "RESOLVED",
  "CONFIRMED",
  "REJECTED",
  "AUTO_CLEARED",
  "REOPENED",
]);
export type AlertEventType = z.infer<typeof AlertEventType>;

export const ALERT_EVENT_LABELS: Record<AlertEventType, string> = {
  RAISED: "Alert raised",
  REPEATED: "Problem reported again",
  SEEN: "Seen",
  READ: "Marked read",
  ACKNOWLEDGED: "Took ownership",
  RESOLVED: "Reported a fix",
  CONFIRMED: "Fix confirmed",
  REJECTED: "Fix rejected: still broken",
  AUTO_CLEARED: "Cleared on its own",
  REOPENED: "Reopened",
};

// ---- Requests --------------------------------------------------------------------------------

export const MarkSeenRequest = z.object({ ids: z.array(id).min(1).max(100) });
export type MarkSeenRequest = z.infer<typeof MarkSeenRequest>;

export const ResolveAlertRequest = z.object({
  resolution: AlertResolution,
  fixAction: FixAction.exclude(["approval_decided"]),
  note: z.string().trim().min(10).max(2000),
});
export type ResolveAlertRequest = z.infer<typeof ResolveAlertRequest>;

export const VerifyAlertRequest = z.object({
  outcome: z.enum(["CONFIRMED", "REJECTED", "REOPEN"]),
  note: z.string().trim().min(3).max(1000),
});
export type VerifyAlertRequest = z.infer<typeof VerifyAlertRequest>;

export const TrackingDays = z.coerce
  .number()
  .int()
  .refine((d) => d === 7 || d === 30 || d === 90);

// ---- Views -----------------------------------------------------------------------------------

/** What a recipient sees about the alert behind one of their notifications. */
export const AlertBrief = z.object({
  id,
  status: AlertStatus,
  actionable: z.boolean(),
  autoVerify: z.boolean(),
  occurrences: z.number().int().positive(),
  ownerName: z.string().nullable(),
  ownerIsMe: z.boolean(),
  resolvedByName: z.string().nullable(),
  resolution: AlertResolution.nullable(),
  fixAction: FixAction.nullable(),
  resolutionNote: z.string().nullable(),
  /** Set after a rejected fix: why it was sent back. */
  lastRejectNote: z.string().nullable(),
});
export type AlertBrief = z.infer<typeof AlertBrief>;

export const AlertRow = z.object({
  id,
  kind: NotificationEvent,
  title: z.string(),
  severity: NotificationSeverity,
  status: AlertStatus,
  siteNames: z.array(z.string()),
  firstRaisedAt: iso,
  lastRaisedAt: iso,
  occurrences: z.number().int().positive(),
  recipients: z.number().int().nonnegative(),
  seenBy: z.number().int().nonnegative(),
  ownerName: z.string().nullable(),
  resolvedByName: z.string().nullable(),
  resolvedAt: iso.nullable(),
  closedAt: iso.nullable(),
  reopenCount: z.number().int().nonnegative(),
});
export type AlertRow = z.infer<typeof AlertRow>;

export const MemberStats = z.object({
  userId: id,
  name: z.string(),
  email: z.string(),
  role: z.string(),
  received: z.number().int().nonnegative(),
  seen: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  /** Actionable alerts they received that are still open and they never looked at. */
  ignoredOpen: z.number().int().nonnegative(),
  medianSeenMs: z.number().nullable(),
  acknowledged: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  /** confirmed / (confirmed + rejected); null before any fix was checked. */
  accuracy: z.number().min(0).max(1).nullable(),
  medianResolveMs: z.number().nullable(),
});
export type MemberStats = z.infer<typeof MemberStats>;

export const AlertTrackingReport = z.object({
  days: z.number().int(),
  from: iso,
  to: iso,
  totals: z.object({
    raised: z.number().int(),
    actionable: z.number().int(),
    openNow: z.number().int(),
    criticalOpenNow: z.number().int(),
    unseenOpenNow: z.number().int(),
    awaitingCheck: z.number().int(),
    confirmed: z.number().int(),
    rejected: z.number().int(),
    autoCleared: z.number().int(),
    accuracy: z.number().nullable(),
    medianSeenMs: z.number().nullable(),
    medianAckMs: z.number().nullable(),
    medianResolveMs: z.number().nullable(),
  }),
  funnel: z.array(z.object({ step: z.string(), count: z.number().int() })),
  daily: z.array(
    z.object({ date: z.string(), raised: z.number().int(), closed: z.number().int() }),
  ),
  members: z.array(MemberStats),
  open: z.array(AlertRow),
  recent: z.array(AlertRow),
});
export type AlertTrackingReport = z.infer<typeof AlertTrackingReport>;

export const AlertDetail = z.object({
  alert: AlertRow.extend({
    body: z.string(),
    actionable: z.boolean(),
    autoVerify: z.boolean(),
    firstSeenAt: iso.nullable(),
    acknowledgedAt: iso.nullable(),
    resolution: AlertResolution.nullable(),
    fixAction: FixAction.nullable(),
    resolutionNote: z.string().nullable(),
    verifiedAt: iso.nullable(),
    verifiedByName: z.string().nullable(),
    siteIds: z.array(id),
  }),
  recipients: z.array(
    z.object({
      userId: id,
      name: z.string(),
      email: z.string(),
      role: z.string(),
      deliveredAt: iso,
      seenAt: iso.nullable(),
      readAt: iso.nullable(),
    }),
  ),
  events: z.array(
    z.object({
      id,
      type: AlertEventType,
      /** null = UlixOps itself (a check or a recovery). */
      actorName: z.string().nullable(),
      subjectName: z.string().nullable(),
      note: z.string().nullable(),
      createdAt: iso,
    }),
  ),
  /** Audit rows on the alert's sites (or by its fixer) while it was being handled. */
  evidence: z.array(
    z.object({
      id,
      action: z.string(),
      result: z.string(),
      userName: z.string().nullable(),
      createdAt: iso,
    }),
  ),
});
export type AlertDetail = z.infer<typeof AlertDetail>;

// In-app alert centre rows (Build Order step 11) with their follow-up state.
export const NotificationView = z.object({
  id,
  kind: NotificationEvent,
  title: z.string(),
  body: z.string(),
  severity: NotificationSeverity,
  siteIds: z.array(id),
  seenAt: iso.nullable(),
  readAt: iso.nullable(),
  createdAt: iso,
  /** Follow-up state of the alert behind this notification (A158); null for very old rows. */
  alert: AlertBrief.nullable(),
});
export type NotificationView = z.infer<typeof NotificationView>;

export const NotificationList = z.object({
  notifications: z.array(NotificationView),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationList>;
