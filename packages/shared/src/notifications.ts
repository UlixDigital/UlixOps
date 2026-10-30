// Notification events, channel prefs, and in-app alert centre contracts (Build Order step 11).
import { z } from "zod";

// Local id schema — do not import RecordId from ./users (users imports this module for SettingsView).
const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();

/** Events that can be emailed / posted to Slack (spec §6.8). In-app rows are always written. */
export const NotificationEvent = z.enum([
  "security.NEW_DEVICE_LOGIN",
  "security.ACCOUNT_LOCKED",
  "security.ADMIN_ROLE_GRANTED",
  "security.TWO_FACTOR_RESET",
  "security.HOST_KEY_MISMATCH",
  "deployment.started",
  "deployment.succeeded",
  "deployment.failed",
  "deployment.rolled_back",
  "approval.requested",
  "bulk_update.failed",
  "bulk_update.completed",
]);
export type NotificationEvent = z.infer<typeof NotificationEvent>;

export const NOTIFICATION_EVENTS = NotificationEvent.options;

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  "security.NEW_DEVICE_LOGIN": "Sign-in from a new device",
  "security.ACCOUNT_LOCKED": "Account locked after failed attempts",
  "security.ADMIN_ROLE_GRANTED": "Admin role granted",
  "security.TWO_FACTOR_RESET": "Two-factor authentication reset",
  "security.HOST_KEY_MISMATCH": "Site SSH host key mismatch",
  "deployment.started": "Deployment started",
  "deployment.succeeded": "Deployment finished successfully",
  "deployment.failed": "Deployment failed",
  "deployment.rolled_back": "Automatic rollback after failed health check",
  "approval.requested": "Approval requested",
  "bulk_update.failed": "Bulk plugin/theme update failed",
  "bulk_update.completed": "Bulk plugin/theme update completed",
};

export const NotificationSeverity = z.enum(["info", "warning", "critical"]);
export type NotificationSeverity = z.infer<typeof NotificationSeverity>;

const EventFlags = z.record(NotificationEvent, z.boolean());

export const NotificationChannelPrefs = z.object({
  /** Master switch; delivery also requires the integration to be configured. */
  enabled: z.boolean(),
  events: EventFlags,
});
export type NotificationChannelPrefs = z.infer<typeof NotificationChannelPrefs>;

export const NotificationPrefs = z.object({
  email: NotificationChannelPrefs,
  slack: NotificationChannelPrefs,
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

/** Defaults: every event on for both channels; Admins may turn individual events off. */
export function defaultNotificationPrefs(): NotificationPrefs {
  const events = Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, true])) as Record<
    NotificationEvent,
    boolean
  >;
  return {
    email: { enabled: true, events },
    slack: { enabled: true, events },
  };
}

/** Merge stored prefs with defaults so new event kinds appear after upgrades. */
export function mergeNotificationPrefs(raw: unknown): NotificationPrefs {
  const defaults = defaultNotificationPrefs();
  if (!raw || typeof raw !== "object") return defaults;
  const obj = raw as Record<string, unknown>;

  const mergeChannel = (
    base: NotificationChannelPrefs,
    patch: unknown,
  ): NotificationChannelPrefs => {
    if (!patch || typeof patch !== "object") return base;
    const p = patch as { enabled?: unknown; events?: unknown };
    const events = { ...base.events };
    if (p.events && typeof p.events === "object") {
      for (const [key, value] of Object.entries(p.events as Record<string, unknown>)) {
        if (
          (NOTIFICATION_EVENTS as readonly string[]).includes(key) &&
          typeof value === "boolean"
        ) {
          events[key as NotificationEvent] = value;
        }
      }
    }
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
      events,
    };
  };

  return {
    email: mergeChannel(defaults.email, obj.email),
    slack: mergeChannel(defaults.slack, obj.slack),
  };
}

export const NotificationView = z.object({
  id,
  kind: NotificationEvent,
  title: z.string(),
  body: z.string(),
  severity: NotificationSeverity,
  siteIds: z.array(id),
  readAt: iso.nullable(),
  createdAt: iso,
});
export type NotificationView = z.infer<typeof NotificationView>;

export const NotificationList = z.object({
  notifications: z.array(NotificationView),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationList>;

export const NotificationPrefsView = z.object({
  prefs: NotificationPrefs,
  /** Whether SMTP_URL / SLACK_WEBHOOK_URL are set (never the values). */
  configured: z.object({
    email: z.boolean(),
    slack: z.boolean(),
  }),
});
export type NotificationPrefsView = z.infer<typeof NotificationPrefsView>;
