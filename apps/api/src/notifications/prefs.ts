import {
  defaultNotificationPrefs,
  mergeNotificationPrefs,
  NotificationPrefs,
  type NotificationPrefs as Prefs,
} from "@ulixops/shared";
import type { Db } from "../db";

export const NOTIFICATION_PREFS_KEY = "notifications.prefs";

export async function readNotificationPrefs(db: Db): Promise<Prefs> {
  const row = await db.setting.findUnique({ where: { key: NOTIFICATION_PREFS_KEY } });
  return mergeNotificationPrefs(row?.value);
}

export async function writeNotificationPrefs(db: Db, value: Prefs, userId: string): Promise<Prefs> {
  const next = NotificationPrefs.parse(value);
  // Re-merge so the stored shape always includes every known event key.
  const complete = mergeNotificationPrefs(next);
  await db.setting.upsert({
    where: { key: NOTIFICATION_PREFS_KEY },
    create: { key: NOTIFICATION_PREFS_KEY, value: complete, updatedById: userId },
    update: { value: complete, updatedById: userId },
  });
  return complete;
}

export { defaultNotificationPrefs };
