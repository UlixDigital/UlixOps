"use server";
import {
  defaultNotificationPrefs,
  NotificationPrefs,
  NotificationPrefsView,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
} from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

export async function saveNotificationPrefsAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const base = defaultNotificationPrefs();
  const emailEvents = { ...base.email.events };
  const slackEvents = { ...base.slack.events };
  for (const event of NOTIFICATION_EVENTS) {
    emailEvents[event as NotificationEvent] = form.get(`email:${event}`) === "on";
    slackEvents[event as NotificationEvent] = form.get(`slack:${event}`) === "on";
  }
  const prefs = NotificationPrefs.parse({
    email: { enabled: form.get("emailEnabled") === "on", events: emailEvents },
    slack: { enabled: form.get("slackEnabled") === "on", events: slackEvents },
  });
  const res = await apiSend(
    "PUT",
    "/notifications/prefs",
    prefs,
    NotificationPrefsView,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Notification settings saved");
  revalidatePath("/settings");
  return {};
}
