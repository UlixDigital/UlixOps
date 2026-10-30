import { describe, expect, it } from "vitest";
import {
  defaultNotificationPrefs,
  mergeNotificationPrefs,
  NOTIFICATION_EVENTS,
  NotificationEvent,
} from "./notifications";

describe("notification prefs", () => {
  it("defaults every known event on for email and Slack", () => {
    const prefs = defaultNotificationPrefs();
    expect(prefs.email.enabled).toBe(true);
    expect(prefs.slack.enabled).toBe(true);
    for (const event of NOTIFICATION_EVENTS) {
      expect(prefs.email.events[event]).toBe(true);
      expect(prefs.slack.events[event]).toBe(true);
    }
  });

  it("fills missing events after an upgrade", () => {
    const merged = mergeNotificationPrefs({
      email: { enabled: false, events: { "deployment.failed": false } },
    });
    expect(merged.email.enabled).toBe(false);
    expect(merged.email.events["deployment.failed"]).toBe(false);
    expect(merged.email.events["approval.requested"]).toBe(true);
    expect(merged.slack.enabled).toBe(true);
  });

  it("lists the Phase 1 event catalog", () => {
    expect(NotificationEvent.options).toContain("deployment.started");
    expect(NotificationEvent.options).toContain("security.HOST_KEY_MISMATCH");
  });
});
