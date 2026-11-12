// In-app notifications + prefs; email/Slack transports are stubbed (real Postgres).
import type { NotifyInput } from "./dispatch";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import type { SecurityAlertEvent, SecurityNotifier } from "../notify";
import { createHubNotifier } from "../notify";
import type { Mailer, SlackPoster } from "./channels";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 30, 14, 0, 0));

describe.runIf(TEST_DATABASE_URL)("notifications (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  const mails: { to: string[]; subject: string; text: string }[] = [];
  const slacks: string[] = [];
  const mailer: Mailer = {
    send: async (m) => {
      mails.push(m);
    },
  };
  const slack: SlackPoster = {
    post: async (text) => {
      slacks.push(text);
    },
  };
  let notifier: SecurityNotifier;
  let app: ReturnType<typeof createApp>;
  const auth = new AuthService({
    db,
    guard: new LoginGuard(new MemoryCounter(now), SECRET),
    notifier: { alert: async () => {} },
    now,
    sessionSecret: SECRET,
    totpKey: "ab".repeat(32),
    issuer: "UlixOps",
    webauthn: { rpID: "localhost", rpName: "UlixOps", origin: "http://localhost:3000" },
    dummyPasswordHash: "unused",
  });

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (p: string) => set(request(app).get(p)),
      put: (p: string, body: object) => set(request(app).put(p)).send(body),
      post: (p: string, body: object = {}) => set(request(app).post(p)).send(body),
    };
  };
  const make = (role: "ADMIN" | "DEVELOPER" | "VIEWER", email?: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, ...(email ? { email } : {}) });

  beforeEach(async () => {
    await resetData(ownerUrl);
    mails.length = 0;
    slacks.length = 0;
    notifier = createHubNotifier({
      db,
      now,
      mailer,
      slack,
      publicUrl: "http://localhost:3000",
    });
    app = createApp({
      auth,
      db,
      now,
      notifier,
      sessionSecret: SECRET,
      publicUrl: "http://localhost:3000",
      configured: { smtp: true, slack: true },
    });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("writes in-app rows and emails Admins for a security alert", async () => {
    const admin = await make("ADMIN", "admin@example.test");
    await make("DEVELOPER", "dev@example.test");
    const event: SecurityAlertEvent = {
      kind: "NEW_DEVICE_LOGIN",
      userId: admin.user.id,
      ip: "203.0.113.10",
      userAgent: "test",
      at: NOW,
    };
    // raiseAlert path is covered elsewhere; exercise hub notify/alert directly.
    expect(notifier.alert).toBeTypeOf("function");
    await notifier.alert(event);

    const list = await as(admin.token).get("/notifications").expect(200);
    expect(list.body.unreadCount).toBe(1);
    expect(list.body.notifications[0]).toMatchObject({
      kind: "security.NEW_DEVICE_LOGIN",
      title: "Sign-in from a new device",
      alert: { actionable: false, status: "INFO" },
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toEqual(["admin@example.test"]);
    expect(slacks).toHaveLength(1);

    const firstId = list.body.notifications[0]?.id as string;
    await as(admin.token).post(`/notifications/${firstId}/read`).expect(200);
    const again = await as(admin.token).get("/notifications").expect(200);
    expect(again.body.unreadCount).toBe(0);
    expect(again.body.notifications[0]?.readAt).toBeTruthy();
  });

  it("lets Admins turn off an event for email while Slack still fires", async () => {
    const admin = await make("ADMIN", "admin@example.test");
    const prefs = await as(admin.token).get("/notifications/prefs").expect(200);
    expect(prefs.body.configured).toEqual({ email: true, slack: true });

    const next = structuredClone(prefs.body.prefs);
    next.email.events["deployment.failed"] = false;
    await as(admin.token).put("/notifications/prefs", next).expect(200);

    expect(notifier.notify).toBeTypeOf("function");
    await notifier.notify?.({
      kind: "deployment.failed",
      title: "Deployment failed",
      body: "x",
      severity: "critical",
      recipientUserIds: [admin.user.id],
    } satisfies NotifyInput);

    expect(mails).toHaveLength(0);
    expect(slacks).toHaveLength(1);
  });

  it("includes notification prefs on Settings and refuses Viewers managing prefs", async () => {
    const admin = await make("ADMIN");
    const viewer = await make("VIEWER", "viewer@example.test");
    const settings = await as(admin.token).get("/settings").expect(200);
    expect(settings.body.notificationPrefs.email.enabled).toBe(true);
    await as(viewer.token).get("/notifications").expect(200);
    await as(viewer.token).put("/notifications/prefs", settings.body.notificationPrefs).expect(403);
  });
});
