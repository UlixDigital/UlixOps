// Alert follow-up end to end on real Postgres (A158): seen, take, fix, recurrence, checks.
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import { createHubNotifier, type SecurityNotifier } from "../notify";

const SECRET = "s".repeat(64);
let NOW = new Date(Date.UTC(2026, 10, 1, 8, 0, 0));
const later = (minutes: number) => {
  NOW = new Date(NOW.getTime() + minutes * 60_000);
};

describe.runIf(TEST_DATABASE_URL)("alert follow-up (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  let notifier: Required<SecurityNotifier>;
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
      post: (p: string, body: object = {}) => set(request(app).post(p)).send(body),
    };
  };
  const make = (role: "SUPER_ADMIN" | "ADMIN" | "VIEWER", email: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, email });
  const malware = () =>
    notifier.notify({
      kind: "malware.found",
      title: "Malware found on Shop (production)",
      body: "1 file matched",
      severity: "critical",
      siteIds: ["site1"],
      scope: "env1",
    });
  const fix = (note = "Deleted the injected shadow.php and rotated keys") => ({
    resolution: "FIXED",
    fixAction: "removed_malware",
    note,
  });

  beforeEach(async () => {
    NOW = new Date(Date.UTC(2026, 10, 1, 8, 0, 0));
    await resetData(ownerUrl);
    notifier = createHubNotifier({
      db,
      now,
      mailer: null,
      slack: null,
      publicUrl: "http://localhost:3000",
    }) as Required<SecurityNotifier>;
    app = createApp({ auth, db, now, notifier, sessionSecret: SECRET });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("tracks seen, owner, a rejected fix, a confirmed fix and accuracy", async () => {
    const boss = await make("SUPER_ADMIN", "boss@example.test");
    const ana = await make("ADMIN", "ana@example.test");
    const ben = await make("ADMIN", "ben@example.test");
    await malware();

    const list = await as(ana.token).get("/notifications").expect(200);
    const n = list.body.notifications[0];
    expect(n.alert).toMatchObject({ status: "OPEN", actionable: true, autoVerify: true });
    expect(n.seenAt).toBeNull();
    const alertId = n.alert.id as string;

    later(2);
    await as(ana.token)
      .post("/notifications/seen", { ids: [n.id] })
      .expect(200);
    later(2);
    await as(ben.token).post(`/notifications/alerts/${alertId}/acknowledge`).expect(200);
    later(5);
    await as(ana.token)
      .post(`/notifications/alerts/${alertId}/resolve`, fix("too short"))
      .expect(400);
    await as(ana.token).post(`/notifications/alerts/${alertId}/resolve`, fix()).expect(200);
    // Resolving twice is refused: someone already moved it on.
    await as(ben.token).post(`/notifications/alerts/${alertId}/resolve`, fix()).expect(409);

    // The next scan still finds malware (clock jumps stay under the 30 min idle timeout): Ana's fix is rejected and the alert reopens.
    later(5);
    await malware();
    let alert = await db.alert.findUniqueOrThrow({ where: { id: alertId } });
    expect(alert).toMatchObject({ status: "OPEN", occurrences: 2, reopenCount: 1 });
    expect(alert.resolvedById).toBeNull();
    expect(alert.ownerId).toBe(ben.user.id);
    expect(await db.alert.count()).toBe(1);

    later(5);
    await as(ben.token).post(`/notifications/alerts/${alertId}/resolve`, fix()).expect(200);
    later(5);
    await notifier.observe({
      kind: "malware.found",
      siteIds: ["site1"],
      scope: "env1",
      ok: true,
      note: "A later malware scan came back clean",
    });
    alert = await db.alert.findUniqueOrThrow({ where: { id: alertId } });
    expect(alert.status).toBe("VERIFIED");
    expect(alert.verifiedById).toBeNull(); // confirmed by the check, not a person

    await as(ana.token).get("/alert-tracking").expect(403);
    const report = await as(boss.token).get("/alert-tracking?days=7").expect(200);
    const byEmail = new Map((report.body.members as { email: string }[]).map((m) => [m.email, m]));
    expect(byEmail.get("ana@example.test")).toMatchObject({
      resolved: 1,
      rejected: 1,
      accuracy: 0,
      seen: 1,
    });
    expect(byEmail.get("ben@example.test")).toMatchObject({
      acknowledged: 1,
      resolved: 1,
      confirmed: 1,
      accuracy: 1,
    });
    expect(report.body.totals).toMatchObject({ confirmed: 1, rejected: 1, accuracy: 0.5 });
    expect(report.body.funnel.map((s: { count: number }) => s.count)).toEqual([1, 1, 1, 1, 1]);
    await as(boss.token).get("/alert-tracking?days=12").expect(400);

    const detail = await as(boss.token).get(`/alert-tracking/${alertId}`).expect(200);
    expect(detail.body.recipients).toHaveLength(3);
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual([
      "RAISED",
      "SEEN",
      "ACKNOWLEDGED",
      "SEEN",
      "RESOLVED",
      "READ",
      "REJECTED",
      "REPEATED",
      "RESOLVED",
      "SEEN", // Ben's notification of the repeat
      "READ",
      "CONFIRMED",
    ]);
    const audits = await db.auditLog.findMany({ where: { action: { startsWith: "alert." } } });
    expect(audits.map((a) => `${a.action}:${a.result}`).sort()).toEqual([
      "alert.acknowledge:success",
      "alert.resolve:alert_state",
      "alert.resolve:success",
      "alert.resolve:success",
    ]);
  });

  it("needs a Super Admin to confirm fixes the hub can't re-check", async () => {
    const boss = await make("SUPER_ADMIN", "boss@example.test");
    const ana = await make("ADMIN", "ana@example.test");
    const viewer = await make("VIEWER", "viewer@example.test");
    await notifier.notify({
      kind: "deployment.failed",
      title: "Deployment failed",
      body: "x",
      severity: "critical",
      siteIds: ["site1"],
    });
    const alert = await db.alert.findFirstOrThrow();
    // Not a recipient: can't act on it.
    await as(viewer.token).post(`/notifications/alerts/${alert.id}/acknowledge`).expect(404);
    await as(ana.token)
      .post(`/notifications/alerts/${alert.id}/resolve`, {
        resolution: "FIXED",
        fixAction: "rolled_back",
        note: "Rolled back to 2.3.1 and redeployed",
      })
      .expect(200);
    await as(ana.token)
      .post(`/alert-tracking/${alert.id}/verify`, { outcome: "CONFIRMED", note: "ok" })
      .expect(403);
    await as(boss.token)
      .post(`/alert-tracking/${alert.id}/verify`, { outcome: "CONFIRMED", note: "Checked live" })
      .expect(200);
    await as(boss.token)
      .post(`/alert-tracking/${alert.id}/verify`, { outcome: "CONFIRMED", note: "again" })
      .expect(409);
    await as(boss.token)
      .post(`/alert-tracking/${alert.id}/verify`, { outcome: "REOPEN", note: "Broke again" })
      .expect(200);
    const reopened = await db.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(reopened.status).toBe("OPEN");
    const report = await as(boss.token).get("/alert-tracking").expect(200);
    const ana2 = report.body.members.find((m: { email: string }) => m.email === "ana@example.test");
    expect(ana2).toMatchObject({ confirmed: 0, rejected: 1 });
  });

  it("clears an untouched alert when the site recovers, and keeps info events closed", async () => {
    await make("ADMIN", "ana@example.test");
    const down = {
      kind: "uptime.down" as const,
      title: "Site down: Shop",
      body: "x",
      severity: "critical" as const,
      siteIds: ["site1"],
    };
    await notifier.notify({ ...down, scope: "env1" });
    await notifier.notify({ ...down, siteIds: ["site2"], scope: "env2" });
    later(10);
    await notifier.notify({
      kind: "uptime.up",
      title: "Site back up: Shop",
      body: "x",
      severity: "info",
      siteIds: ["site1"],
      scope: "env1",
    });
    const alerts = await db.alert.findMany({ orderBy: { firstRaisedAt: "asc" } });
    const status = Object.fromEntries(alerts.map((a) => [`${a.kind}:${a.siteIds[0]}`, a.status]));
    expect(status).toEqual({
      "uptime.down:site1": "AUTO_CLEARED",
      "uptime.down:site2": "OPEN",
      "uptime.up:site1": "INFO",
    });
  });

  it("credits the owner when a clean check arrives without Report fix (A176)", async () => {
    const ana = await make("ADMIN", "ana@example.test");
    await malware();
    const alert = await db.alert.findFirstOrThrow();
    await as(ana.token).post(`/notifications/alerts/${alert.id}/acknowledge`).expect(200);
    later(5);
    await notifier.observe({
      kind: "malware.found",
      siteIds: ["site1"],
      scope: "env1",
      ok: true,
      note: "A later malware scan came back clean",
    });
    const done = await db.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(done).toMatchObject({
      status: "VERIFIED",
      resolvedById: ana.user.id,
      ownerId: ana.user.id,
      resolution: "FIXED",
    });
  });

  it("credits a hub action without I'm on it (A176)", async () => {
    const ana = await make("ADMIN", "ana@example.test");
    await malware();
    const alert = await db.alert.findFirstOrThrow();
    later(5);
    await notifier.observe({
      kind: "malware.found",
      siteIds: ["site1"],
      scope: "env1",
      ok: true,
      byUserId: ana.user.id,
      fixAction: "marked_known_safe",
      note: "Marked remaining matches known-safe",
    });
    const done = await db.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(done).toMatchObject({
      status: "VERIFIED",
      resolvedById: ana.user.id,
      fixAction: "marked_known_safe",
      resolution: "FIXED",
    });
  });

  it("credits whoever decides an approval request", async () => {
    await make("SUPER_ADMIN", "boss@example.test");
    const ana = await make("ADMIN", "ana@example.test");
    await notifier.notify({
      kind: "approval.requested",
      title: "Approval requested",
      body: "x",
      severity: "warning",
      scope: "req1",
    });
    const alert = await db.alert.findFirstOrThrow();
    await as(ana.token).post(`/notifications/alerts/${alert.id}/resolve`, fix()).expect(409); // decided on the Approvals page, not here
    await notifier.observe({
      kind: "approval.requested",
      scope: "req1",
      ok: true,
      byUserId: ana.user.id,
      note: "Request approved",
    });
    const done = await db.alert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(done).toMatchObject({
      status: "VERIFIED",
      resolvedById: ana.user.id,
      fixAction: "approval_decided",
    });
  });

  it("keeps the alert timeline append-only", async () => {
    await make("ADMIN", "ana@example.test");
    await malware();
    const event = await db.alertEvent.findFirstOrThrow();
    await expect(
      db.alertEvent.update({ where: { id: event.id }, data: { note: "edited" } }),
    ).rejects.toThrow();
    await expect(db.alertEvent.delete({ where: { id: event.id } })).rejects.toThrow();
  });
});
