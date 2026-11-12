import { observeAlerts, type ObserveInput } from "./alerts/followup";
import type { Db } from "./db";
import type { Mailer, SlackPoster } from "./notifications/channels";
import { adminUserIds, notify, type NotifyInput } from "./notifications/dispatch";

export interface SecurityAlertEvent {
  kind:
    | "NEW_DEVICE_LOGIN"
    | "ACCOUNT_LOCKED"
    | "ADMIN_ROLE_GRANTED"
    | "TWO_FACTOR_RESET"
    | "HOST_KEY_MISMATCH";
  userId: string;
  ip: string;
  userAgent: string;
  at: Date;
}

export interface SecurityNotifier {
  alert(event: SecurityAlertEvent): Promise<void>;
  /** Optional: operational events (deploy / approval). Hub notifier always implements this. */
  notify?(input: NotifyInput): Promise<void>;
  /**
   * Optional: a later check on a problem that was alerted (clean or still failing), so the
   * alert follow-up can confirm or reject a reported fix (A158).
   */
  observe?(input: ObserveInput): Promise<void>;
}

/**
 * Alerts are stored as SecurityAlert rows (raiseAlert) then delivered here: in-app
 * Notification rows + optional email/Slack (Build Order step 11, A26 / A85).
 */
export function createHubNotifier(deps: {
  db: Db;
  now: () => Date;
  mailer: Mailer | null;
  slack: SlackPoster | null;
  publicUrl: string;
}): SecurityNotifier {
  const channels = {
    db: deps.db,
    now: deps.now,
    mailer: deps.mailer,
    slack: deps.slack,
    publicUrl: deps.publicUrl,
  };

  return {
    async notify(input) {
      await notify(channels, input);
    },
    async observe(input) {
      await observeAlerts(deps.db, input, deps.now());
    },
    async alert(event) {
      console.warn(
        JSON.stringify({
          event: "security_alert",
          kind: event.kind,
          userId: event.userId,
          ip: event.ip,
          at: event.at.toISOString(),
        }),
      );
      const subject = await deps.db.user.findUnique({
        where: { id: event.userId },
        select: { email: true },
      });
      const who = subject?.email ?? "a user";
      const severity =
        event.kind === "HOST_KEY_MISMATCH" || event.kind === "ACCOUNT_LOCKED"
          ? ("critical" as const)
          : ("warning" as const);
      const titles: Record<SecurityAlertEvent["kind"], string> = {
        NEW_DEVICE_LOGIN: "Sign-in from a new device",
        ACCOUNT_LOCKED: "Account locked after failed attempts",
        ADMIN_ROLE_GRANTED: "Admin role granted",
        TWO_FACTOR_RESET: "Two-factor authentication reset",
        HOST_KEY_MISMATCH: "A site's SSH host key changed",
      };
      await notify(channels, {
        kind: `security.${event.kind}`,
        title: titles[event.kind],
        body: `${who} · IP ${event.ip || "unknown"}`,
        severity,
        recipientUserIds: await adminUserIds(deps.db),
        meta: { subjectUserId: event.userId, ip: event.ip },
        scope: event.userId,
      });
    },
  };
}

/**
 * Test / fallback notifier: logs only, no DB fan-out (integration tests supply their own).
 */
export const logNotifier: SecurityNotifier = {
  async alert(event) {
    console.warn(
      JSON.stringify({
        event: "security_alert",
        kind: event.kind,
        userId: event.userId,
        ip: event.ip,
        at: event.at.toISOString(),
      }),
    );
  },
};
