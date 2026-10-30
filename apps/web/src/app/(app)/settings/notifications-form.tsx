"use client";
import {
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_EVENTS,
  type NotificationPrefs,
} from "@ulixops/shared";
import { useActionState } from "react";
import type { ActionState } from "@/components/action-form";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { saveNotificationPrefsAction } from "./notifications-actions";

export function NotificationsForm({
  prefs,
  configured,
}: {
  prefs: NotificationPrefs;
  configured: { email: boolean; slack: boolean };
}) {
  const [state, action] = useActionState<ActionState, FormData>(saveNotificationPrefsAction, {});

  return (
    <form action={action} className="grid gap-4">
      <FormPendingOverlay label="Saving notification settings…" />
      <input type="hidden" name="prefs" value={JSON.stringify(prefs)} />
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Email</legend>
        <p className="text-xs text-muted-foreground">
          {configured.email
            ? "SMTP is configured on the server."
            : "Set SMTP_URL on the server to send email."}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="emailEnabled" defaultChecked={prefs.email.enabled} />
          Send email for selected events
        </label>
        <ul className="grid gap-1.5 rounded-md border p-3">
          {NOTIFICATION_EVENTS.map((event) => (
            <li key={`email-${event}`}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name={`email:${event}`}
                  defaultChecked={prefs.email.events[event] !== false}
                  className="mt-0.5"
                />
                <span>{NOTIFICATION_EVENT_LABELS[event]}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Slack</legend>
        <p className="text-xs text-muted-foreground">
          {configured.slack
            ? "Slack webhook is configured on the server."
            : "Set SLACK_WEBHOOK_URL on the server to post to Slack."}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="slackEnabled" defaultChecked={prefs.slack.enabled} />
          Post to Slack for selected events
        </label>
        <ul className="grid gap-1.5 rounded-md border p-3">
          {NOTIFICATION_EVENTS.map((event) => (
            <li key={`slack-${event}`}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name={`slack:${event}`}
                  defaultChecked={prefs.slack.events[event] !== false}
                  className="mt-0.5"
                />
                <span>{NOTIFICATION_EVENT_LABELS[event]}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <PendingSubmit pendingLabel="Saving…">Save notification settings</PendingSubmit>
    </form>
  );
}
