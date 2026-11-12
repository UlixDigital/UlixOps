// Users & roles, My account, settings and alerts through the HTTP routes (real Postgres).
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import type { SecurityAlertEvent } from "../notify";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 29, 12, 0, 0));
const OFFICE_IP = "203.0.113.10";

describe.runIf(TEST_DATABASE_URL)("admin features (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  let alerts: SecurityAlertEvent[] = [];
  const notifier = {
    alert: async (event: SecurityAlertEvent) => {
      alerts.push(event);
    },
  };
  const auth = new AuthService({
    db,
    guard: new LoginGuard(new MemoryCounter(now), SECRET),
    notifier,
    now,
    sessionSecret: SECRET,
    totpKey: "ab".repeat(32),
    issuer: "UlixOps",
    webauthn: { rpID: "localhost", rpName: "UlixOps", origin: "http://localhost:3000" },
    dummyPasswordHash: "unused",
  });
  const app = createApp({
    auth,
    db,
    now,
    notifier,
    sessionSecret: SECRET,
    publicUrl: "https://ulixops.example.test",
    envAllowedIps: ["192.0.2.50"],
    configured: { vault: false, wpengine: true, smtp: false, slack: true },
  });

  const as = (token: string, ip = OFFICE_IP) => ({
    get: (path: string) =>
      request(app).get(path).set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", ip),
    post: (path: string, body: object = {}) =>
      request(app)
        .post(path)
        .set("authorization", `Bearer ${token}`)
        .set("x-ulix-client-ip", ip)
        .send(body),
    patch: (path: string, body: object) =>
      request(app)
        .patch(path)
        .set("authorization", `Bearer ${token}`)
        .set("x-ulix-client-ip", ip)
        .send(body),
    put: (path: string, body: object) =>
      request(app)
        .put(path)
        .set("authorization", `Bearer ${token}`)
        .set("x-ulix-client-ip", ip)
        .send(body),
  });
  const make = (role: "SUPER_ADMIN" | "ADMIN" | "DEVELOPER" | "VIEWER", email?: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, ...(email ? { email } : {}) });
  const lastAudit = (action: string) =>
    db.auditLog.findFirst({ where: { action }, orderBy: { createdAt: "desc" } });

  beforeEach(async () => {
    await resetData(ownerUrl);
    alerts = [];
  });
  afterAll(() => db.$disconnect());

  describe("users", () => {
    it("are managed by Admins only", async () => {
      const dev = await make("DEVELOPER");
      for (const call of [
        as(dev.token).get("/users"),
        as(dev.token).post("/users", { email: "x@example.test", role: "VIEWER" }),
      ]) {
        expect((await call).status).toBe(403);
      }
    });

    it("invites with a one-time setup link, and alerts when someone becomes Admin", async () => {
      const admin = await make("ADMIN");
      const invite = await as(admin.token).post("/users", {
        email: " New.Dev@Example.test ",
        name: "New Dev",
        role: "DEVELOPER",
      });
      expect(invite.status).toBe(201);
      expect(invite.body.user).toMatchObject({
        email: "new.dev@example.test",
        role: "DEVELOPER",
        setupPending: true,
      });
      const link = new URL(invite.body.setupLink as string);
      expect(link.origin + link.pathname).toBe("https://ulixops.example.test/setup");
      const inspect = await request(app)
        .post("/auth/setup/inspect")
        .send({ setupToken: link.searchParams.get("token") });
      expect(inspect.body).toEqual({ email: "new.dev@example.test" });
      expect(await lastAudit("user.invite")).toMatchObject({
        userId: admin.user.id,
        ip: OFFICE_IP,
      });

      expect(
        (await as(admin.token).post("/users", { email: "new.dev@example.test", role: "VIEWER" }))
          .body,
      ).toEqual({
        error: "email_taken",
      });
      expect(
        (await as(admin.token).post("/users", { email: "not-an-email", role: "VIEWER" })).status,
      ).toBe(400);
      expect(alerts).toEqual([]);

      await as(admin.token).post("/users", { email: "boss@example.test", role: "ADMIN" });
      expect(alerts.map((a) => a.kind)).toEqual(["ADMIN_ROLE_GRANTED"]);
    });

    it("re-sends setup links (old ones stop working), and resets passwords after setup", async () => {
      const admin = await make("ADMIN");
      const invite = await as(admin.token).post("/users", {
        email: "late@example.test",
        role: "VIEWER",
      });
      const oldToken = new URL(invite.body.setupLink as string).searchParams.get("token");
      const resend = await as(admin.token).post(`/users/${invite.body.user.id}/setup-link`);
      expect(resend.status).toBe(200);
      const newToken = new URL(resend.body.setupLink as string).searchParams.get("token");
      expect(
        (await request(app).post("/auth/setup/inspect").send({ setupToken: oldToken })).status,
      ).toBe(410);
      expect(
        (await request(app).post("/auth/setup/inspect").send({ setupToken: newToken })).status,
      ).toBe(200);

      // Already set up (with 2FA): the link resets the password, ends sessions, keeps 2FA.
      const viewer = await make("VIEWER");
      const reset = await as(admin.token).post(`/users/${viewer.user.id}/setup-link`);
      expect(await lastAudit("user.password_reset_link")).toMatchObject({ userId: admin.user.id });
      const token = new URL(reset.body.setupLink as string).searchParams.get("token");
      const used = await request(app)
        .post("/auth/setup/password")
        .send({
          setupToken: token,
          password: "a brand new passphrase",
          context: { ip: "203.0.113.5", userAgent: "t", deviceId: "d".repeat(43) },
        });
      expect(used.body.next).toBe("totp");
      expect((await as(viewer.token).get("/me")).status).toBe(401);
      expect((await as(admin.token).post(`/users/${admin.user.id}/setup-link`)).body).toEqual({
        error: "cannot_change_self",
      });
    });

    it("changes roles, records what changed, and stops Admins changing themselves", async () => {
      const admin = await make("ADMIN");
      const viewer = await make("VIEWER");
      const res = await as(admin.token).patch(`/users/${viewer.user.id}`, {
        role: "DEVELOPER",
        name: "Vera",
      });
      expect(res.body.user).toMatchObject({ role: "DEVELOPER", name: "Vera" });
      expect((await lastAudit("user.update"))?.meta).toMatchObject({
        subjectId: viewer.user.id,
        changes: { role: ["VIEWER", "DEVELOPER"], name: [null, "Vera"] },
      });

      await as(admin.token).patch(`/users/${viewer.user.id}`, { role: "ADMIN" });
      expect(alerts.map((a) => a.kind)).toEqual(["ADMIN_ROLE_GRANTED"]);

      for (const body of [{ role: "VIEWER" }, { active: false }]) {
        expect((await as(admin.token).patch(`/users/${admin.user.id}`, body)).body).toEqual({
          error: "cannot_change_self",
        });
      }
      expect((await as(admin.token).patch(`/users/${admin.user.id}`, { name: "Me" })).status).toBe(
        200,
      );
      expect((await as(admin.token).patch(`/users/${viewer.user.id}`, {})).status).toBe(400);
      expect((await as(admin.token).patch("/users/nope", { role: "VIEWER" })).status).toBe(404);
    });

    it("lets a Super Admin promote an Admin with 2FA, and refuses Admins / non-Admins (A172)", async () => {
      const boss = await make("SUPER_ADMIN", "boss@example.test");
      const admin = await make("ADMIN", "admin@example.test");
      const peer = await make("ADMIN", "peer@example.test");
      const viewer = await make("VIEWER", "viewer@example.test");

      expect(
        (await as(admin.token).patch(`/users/${peer.user.id}`, { role: "SUPER_ADMIN" })).body,
      ).toEqual({ error: "forbidden" });

      expect(
        (await as(boss.token).patch(`/users/${viewer.user.id}`, { role: "SUPER_ADMIN" })).body,
      ).toEqual({ error: "needs_admin_2fa" });

      await db.user.update({ where: { id: peer.user.id }, data: { twoFactorEnabled: false } });
      expect(
        (await as(boss.token).patch(`/users/${peer.user.id}`, { role: "SUPER_ADMIN" })).body,
      ).toEqual({ error: "needs_admin_2fa" });
      await db.user.update({ where: { id: peer.user.id }, data: { twoFactorEnabled: true } });

      const promoted = await as(boss.token)
        .patch(`/users/${admin.user.id}`, { role: "SUPER_ADMIN" })
        .expect(200);
      expect(promoted.body.user.role).toBe("SUPER_ADMIN");
      expect((await lastAudit("user.super_admin.grant"))?.meta).toMatchObject({
        subjectId: admin.user.id,
        via: "ui",
        to: "SUPER_ADMIN",
      });

      const demoted = await as(boss.token)
        .patch(`/users/${admin.user.id}`, { role: "ADMIN" })
        .expect(200);
      expect(demoted.body.user.role).toBe("ADMIN");
      expect((await lastAudit("user.super_admin.revoke"))?.meta).toMatchObject({
        subjectId: admin.user.id,
        via: "ui",
        from: "SUPER_ADMIN",
      });
    });

    it("deactivating someone ends their sessions at once", async () => {
      const admin = await make("ADMIN");
      const dev = await make("DEVELOPER");
      expect((await as(dev.token).get("/me")).status).toBe(200);
      await as(admin.token).patch(`/users/${dev.user.id}`, { active: false });
      expect((await as(dev.token).get("/me")).body).toEqual({ error: "session_invalid" });
      const list = await as(admin.token).get("/users");
      expect(list.body.users.find((u: { id: string }) => u.id === dev.user.id)).toMatchObject({
        active: false,
        activeSessions: 0,
      });
    });

    it("resets 2FA: sessions end, the next sign-in sets 2FA up again, Admins are alerted", async () => {
      const admin = await make("ADMIN");
      const dev = await make("DEVELOPER");
      expect((await as(admin.token).post(`/users/${dev.user.id}/reset-2fa`)).body).toEqual({
        ok: true,
      });
      expect(await db.user.findUniqueOrThrow({ where: { id: dev.user.id } })).toMatchObject({
        twoFactorEnabled: false,
        totpSecretEnc: null,
      });
      expect((await as(dev.token).get("/me")).status).toBe(401);
      expect(alerts).toMatchObject([{ kind: "TWO_FACTOR_RESET", userId: dev.user.id }]);
      expect((await as(admin.token).post(`/users/${admin.user.id}/reset-2fa`)).body).toEqual({
        error: "cannot_change_self",
      });
    });

    it("lists and ends someone's sessions", async () => {
      const admin = await make("ADMIN");
      const dev = await make("DEVELOPER");
      const detail = await as(admin.token).get(`/users/${dev.user.id}`);
      expect(detail.body.sessions).toHaveLength(1);
      const sessionId = detail.body.sessions[0].id as string;
      expect(
        (await as(admin.token).post(`/users/${dev.user.id}/sessions/${sessionId}/revoke`)).body,
      ).toEqual({ ok: true });
      expect(
        (await as(admin.token).post(`/users/${dev.user.id}/sessions/${sessionId}/revoke`)).status,
      ).toBe(404);
      expect((await as(dev.token).get("/me")).status).toBe(401);
    });
  });

  describe("my account", () => {
    it("shows the user's own sessions and lets them end the others", async () => {
      const me = await make("VIEWER");
      const other = await db.session.findFirstOrThrow({ where: { userId: me.user.id } });
      const second = await userWithSession(db, "VIEWER", {
        sessionSecret: SECRET,
        now: NOW,
        email: "second@example.test",
      });
      // A second session for the same user:
      await db.session.update({
        where: {
          id: (await db.session.findFirstOrThrow({ where: { userId: second.user.id } })).id,
        },
        data: { userId: me.user.id },
      });

      const account = await as(me.token).get("/account");
      expect(account.body.user).toMatchObject({ email: "viewer@example.test", role: "VIEWER" });
      expect(account.body.sessions).toHaveLength(2);
      expect(account.body.sessions.find((s: { current: boolean }) => s.current).id).toBe(other.id);

      expect((await as(me.token).post("/account/sessions/revoke-others")).body).toEqual({
        ok: true,
      });
      expect((await as(me.token).get("/account")).body.sessions).toHaveLength(1);
      expect((await as(second.token).get("/me")).status).toBe(401);

      expect((await as(me.token).patch("/account", { name: "Viv" })).status).toBe(200);
      expect((await db.user.findUniqueOrThrow({ where: { id: me.user.id } })).name).toBe("Viv");
    });

    it("cannot end other people's sessions", async () => {
      const me = await make("VIEWER");
      const them = await make("DEVELOPER");
      const theirs = await db.session.findFirstOrThrow({ where: { userId: them.user.id } });
      expect((await as(me.token).post(`/account/sessions/${theirs.id}/revoke`)).status).toBe(404);
      expect((await as(them.token).get("/me")).status).toBe(200);
    });
  });

  describe("settings and the IP allowlist", () => {
    it("are Admin-only", async () => {
      const dev = await make("DEVELOPER");
      expect((await as(dev.token).get("/settings")).status).toBe(403);
      expect(
        (await as(dev.token).put("/settings/ip-allowlist", { enabled: false, entries: [] })).status,
      ).toBe(403);
    });

    it("show the policy, integration status (names only) and the caller's IP", async () => {
      const admin = await make("ADMIN");
      const res = await as(admin.token).get("/settings");
      expect(res.body).toMatchObject({
        currentIp: OFFICE_IP,
        envAllowedIps: ["192.0.2.50"],
        ipAllowlist: { enabled: false, entries: [] },
        policy: { idleMinutes: 30, absoluteHours: 12, lockAfterFailures: 5, lockMinutes: 15 },
      });
      const status = Object.fromEntries(
        res.body.integrations.map((i: { key: string; status: string }) => [i.key, i.status]),
      );
      expect(status).toEqual({
        vault: "not_configured",
        wpengine: "configured",
        smtp: "not_configured",
        slack: "configured",
        wordfence: "not_configured",
        drive: "not_configured",
        cloudflare: "planned",
      });
    });

    it("validates entries and refuses a list that would lock the Admin out", async () => {
      const admin = await make("ADMIN");
      const put = (body: object, ip = OFFICE_IP) =>
        as(admin.token, ip).put("/settings/ip-allowlist", body);
      expect((await put({ enabled: true, entries: [{ cidr: "office", label: "" }] })).body).toEqual(
        { error: "invalid_entries" },
      );
      expect(
        (await put({ enabled: true, entries: [{ cidr: "198.51.100.0/24", label: "VPN" }] })).body,
      ).toEqual({
        error: "would_lock_you_out",
      });
      // Allowed through ALLOWED_IPS, the server-side way back in:
      expect(
        (
          await put(
            { enabled: true, entries: [{ cidr: "198.51.100.0/24", label: "VPN" }] },
            "192.0.2.50",
          )
        ).status,
      ).toBe(200);

      const saved = await put({
        enabled: true,
        entries: [
          { cidr: "203.0.113.10/32", label: "Office" },
          { cidr: "2001:db8::/32", label: "" },
        ],
      });
      expect(saved.body).toEqual({
        enabled: true,
        entries: [
          { cidr: "203.0.113.10", label: "Office" },
          { cidr: "2001:db8::/32", label: "" },
        ],
      });
      // Both saves share the fake clock's timestamp, so check the set of audit rows.
      const saves = await db.auditLog.findMany({ where: { action: "settings.ip_allowlist" } });
      expect(saves.map((row) => row.meta)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            before: { enabled: false, entries: [] },
            after: { enabled: true, entries: [{ cidr: "198.51.100.0/24", label: "VPN" }] },
          }),
          expect.objectContaining({
            before: { enabled: true, entries: [{ cidr: "198.51.100.0/24", label: "VPN" }] },
          }),
        ]),
      );
      expect((await request(app).get("/internal/ip-allowlist")).body).toEqual({
        enabled: true,
        cidrs: ["203.0.113.10", "2001:db8::/32"],
      });
    });
  });

  describe("alerts and CSV export", () => {
    it("lists recent security alerts for Admins only", async () => {
      const admin = await make("ADMIN");
      const viewer = await make("VIEWER");
      await as(admin.token).post(`/users/${viewer.user.id}/reset-2fa`);
      const res = await as(admin.token).get("/alerts?limit=5");
      expect(res.body.alerts).toMatchObject([
        { kind: "TWO_FACTOR_RESET", user: { email: "viewer@example.test" } },
      ]);
      const dev = await make("DEVELOPER");
      expect((await as(dev.token).get("/alerts")).status).toBe(403);
    });

    it("exports the audit log as CSV, neutralising spreadsheet formulas, and audits the export", async () => {
      const admin = await make("ADMIN");
      await db.auditLog.createMany({
        data: [
          {
            action: '=HYPERLINK("evil")',
            result: "success",
            siteIds: [],
            createdAt: new Date("2026-10-29T10:00:00Z"),
          },
          {
            action: "auth.login",
            result: "success",
            siteIds: ["a", "b"],
            ip: "203.0.113.1",
            userId: admin.user.id,
            createdAt: new Date("2026-10-29T11:00:00Z"),
            meta: { note: 'x, "y"' },
          },
        ],
      });
      const res = await as(admin.token).get("/audit/export?from=2026-10-29");
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("ulixops-audit-log.csv");
      const lines = res.text.trim().split("\r\n");
      expect(lines[0]).toBe("time_utc,user,action,result,ip,sites,details");
      expect(lines[1]).toBe(
        '2026-10-29T11:00:00.000Z,admin@example.test,auth.login,success,203.0.113.1,a b,"{""note"":""x, \\""y\\""""}"',
      );
      expect(lines[2]).toBe(`2026-10-29T10:00:00.000Z,system,"'=HYPERLINK(""evil"")",success,,,`);
      expect((await lastAudit("audit.export"))?.meta).toMatchObject({
        rows: 2,
        filters: { from: "2026-10-29" },
      });
    });
  });
});
