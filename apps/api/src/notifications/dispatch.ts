// Fan-out: in-app row per recipient, then email / Slack per Admin prefs (agent decision A85–A87).
import {
  NOTIFICATION_EVENT_LABELS,
  type NotificationEvent,
  type NotificationSeverity,
} from "@ulixops/shared";
import type { Db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import type { Mailer, SlackPoster } from "./channels";
import { readNotificationPrefs } from "./prefs";

export interface NotifyInput {
  kind: NotificationEvent;
  title: string;
  body: string;
  severity: NotificationSeverity;
  siteIds?: string[];
  /** When set, only these users get an in-app row (and email if they are Admins). */
  recipientUserIds?: string[];
  meta?: Record<string, unknown>;
}

export interface NotifyDeps {
  db: Db;
  now: () => Date;
  mailer: Mailer | null;
  slack: SlackPoster | null;
  /** Absolute hub URL for deep links in email/Slack text. */
  publicUrl: string;
}

/** Active Admin user ids (notifications that go to "the team"). */
export async function adminUserIds(db: Db): Promise<string[]> {
  const rows = await db.user.findMany({
    where: { role: "ADMIN", active: true },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function emailsOf(db: Db, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db.user.findMany({
    where: { id: { in: userIds }, active: true },
    select: { email: true },
  });
  return rows.map((r) => r.email);
}

/**
 * Writes in-app notifications and optionally emails Admins / posts to Slack.
 * Never throws to the caller — channel failures are logged only.
 */
export async function notify(deps: NotifyDeps, input: NotifyInput): Promise<void> {
  const { db, now } = deps;
  try {
    const recipients =
      input.recipientUserIds && input.recipientUserIds.length > 0
        ? [...new Set(input.recipientUserIds)]
        : await adminUserIds(db);
    if (recipients.length === 0) return;

    const at = now();
    const siteIds = input.siteIds ?? [];
    await db.notification.createMany({
      data: recipients.map((userId) => ({
        kind: input.kind,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 2000),
        severity: input.severity,
        userId,
        siteIds,
        ...(input.meta ? { meta: input.meta as Prisma.InputJsonValue } : {}),
        createdAt: at,
      })),
    });

    const prefs = await readNotificationPrefs(db);
    const label = NOTIFICATION_EVENT_LABELS[input.kind] ?? input.kind;
    const link = `${deps.publicUrl.replace(/\/$/, "")}/notifications`;
    const text = `${input.title}\n\n${input.body}\n\nOpen UlixOps: ${link}`;

    if (deps.mailer && prefs.email.enabled && prefs.email.events[input.kind] !== false) {
      try {
        const to = await emailsOf(db, recipients);
        if (to.length > 0) {
          await deps.mailer.send({
            to,
            subject: `[UlixOps] ${label}`,
            text,
          });
        }
      } catch (error) {
        console.error(
          `notifications: email failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      }
    }

    if (deps.slack && prefs.slack.enabled && prefs.slack.events[input.kind] !== false) {
      try {
        await deps.slack.post(`*${input.title}*\n${input.body}\n${link}`);
      } catch (error) {
        console.error(
          `notifications: Slack failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      }
    }
  } catch (error) {
    console.error(
      `notifications: dispatch failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}
