// Notification events, channel prefs, and in-app alert centre contracts (Build Order step 11).
import { z } from "zod";

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
  "approval.self_approved",
  "bulk_update.failed",
  "bulk_update.completed",
  "vulnerability.found",
  "malware.found",
  "integrity.changed",
  "backup.failed",
  "backup.skipped",
  "restore.succeeded",
  "restore.failed",
  "ssl.expiring",
  "ssl.invalid",
  "domain.expiring",
  "uptime.down",
  "uptime.up",
  "dns.changed",
  "php.fatal",
  "php.logging",
  "autoupdate.completed",
  "autoupdate.problems",
  "visual.changed",
  "visual.failed",
  "report.ready",
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
  "approval.self_approved": "A Super Admin approved their own risky action",
  "bulk_update.failed": "Bulk plugin/theme update failed",
  "bulk_update.completed": "Bulk plugin/theme update completed",
  "vulnerability.found": "New vulnerability found on a site",
  "malware.found": "Malware scan found infected files",
  "integrity.changed": "WordPress or plugin files changed",
  "backup.failed": "Google Drive backup failed",
  "backup.skipped": "Backup skipped: the site wasn't healthy",
  "restore.succeeded": "Site restored from a Google Drive backup",
  "restore.failed": "Restore from a Google Drive backup failed",
  "ssl.expiring": "SSL certificate expires soon",
  "ssl.invalid": "SSL certificate problem (untrusted, wrong name or unreachable)",
  "domain.expiring": "Domain registration expires soon",
  "uptime.down": "Site down (two failed uptime checks in a row)",
  "uptime.up": "Site back up after downtime",
  "dns.changed": "Cloudflare DNS records changed outside UlixOps",
  "php.fatal": "New PHP fatal error in a site's error log",
  "php.logging": "PHP error logging switched on for several sites",
  "autoupdate.completed": "Scheduled updates installed",
  "autoupdate.problems": "Scheduled updates rolled back, failed or skipped",
  "visual.changed": "Site pages look different after a deploy or update",
  "visual.failed": "Visual check could not take screenshots",
  "report.ready": "Monthly client report is ready",
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

export const NotificationPrefsView = z.object({
  prefs: NotificationPrefs,
  /** Whether SMTP_URL / SLACK_WEBHOOK_URL are set (never the values). */
  configured: z.object({
    email: z.boolean(),
    slack: z.boolean(),
  }),
});
export type NotificationPrefsView = z.infer<typeof NotificationPrefsView>;
