import { audit } from "./audit";
import type { Db } from "./db";
import type { SecurityAlertEvent, SecurityNotifier } from "./notify";

/** Stores a security alert, records it in the audit log, then tells the notifier. */
export async function raiseAlert(
  db: Db,
  notifier: SecurityNotifier,
  alert: Omit<SecurityAlertEvent, "at"> & { actorId?: string },
  at: Date,
): Promise<void> {
  const { kind, userId, ip, userAgent, actorId } = alert;
  await db.securityAlert.create({
    data: { kind, userId, ip, userAgent, createdAt: at, meta: actorId ? { actorId } : undefined },
  });
  await audit(
    db,
    {
      userId: actorId ?? userId,
      action: `security.${kind.toLowerCase()}`,
      result: "alert",
      ip,
      meta: { subjectId: userId },
    },
    at,
  );
  try {
    await notifier.alert({ kind, userId, ip, userAgent, at });
  } catch (error) {
    // A failing channel must never block the action; the alert row is already stored.
    console.error(`alerts: delivery failed: ${error instanceof Error ? error.name : "unknown"}`);
  }
}
