// Append-only audit log (database level) and role checks on the API (real Postgres).
import { ROLE_PERMISSIONS } from "@ulixops/shared";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 29, 12, 0, 0));
const DENIED = /permission denied|42501/i;

describe.runIf(TEST_DATABASE_URL)("audit log and roles (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const owner = createPrisma(ownerUrl);
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  const auth = new AuthService({
    db,
    guard: new LoginGuard(new MemoryCounter(now), SECRET),
    notifier: { alert: async () => undefined },
    now,
    sessionSecret: SECRET,
    totpKey: "ab".repeat(32),
    issuer: "UlixOps",
    webauthn: { rpID: "localhost", rpName: "UlixOps", origin: "http://localhost:3000" },
    dummyPasswordHash: "unused",
  });
  const app = createApp({ auth, db, now });

  beforeEach(() => resetData(ownerUrl));
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), db.$disconnect()]);
  });

  const entry = (action: string, at: string, extra: object = {}) => ({
    action,
    result: "success",
    siteIds: [],
    createdAt: new Date(at),
    ...extra,
  });

  async function rawAsApp(sql: string) {
    const client = new pg.Client({ connectionString: asAppRole(ownerUrl) });
    await client.connect();
    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  }

  describe("database protection", () => {
    it("lets the API's role add and read entries", async () => {
      const row = await db.auditLog.create({ data: entry("test.write", "2026-10-29T10:00:00Z") });
      expect(await db.auditLog.findUnique({ where: { id: row.id } })).toMatchObject({
        action: "test.write",
      });
    });

    it("refuses UPDATE, DELETE and TRUNCATE of audit entries for the API's role", async () => {
      const row = await db.auditLog.create({ data: entry("test.keep", "2026-10-29T10:00:00Z") });
      await expect(
        db.auditLog.update({ where: { id: row.id }, data: { result: "edited" } }),
      ).rejects.toThrow(DENIED);
      await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(DENIED);
      await expect(db.auditLog.deleteMany()).rejects.toThrow(DENIED);
      await expect(rawAsApp('TRUNCATE "AuditLog"')).rejects.toThrow(DENIED);
      expect(await owner.auditLog.count()).toBe(1);
    });

    it("blocks changes even for the database owner", async () => {
      const row = await owner.auditLog.create({ data: entry("test.keep", "2026-10-29T10:00:00Z") });
      await expect(
        owner.auditLog.update({ where: { id: row.id }, data: { result: "edited" } }),
      ).rejects.toThrow(/append-only/);
      await expect(owner.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
      expect(await owner.auditLog.findUnique({ where: { id: row.id } })).toMatchObject({
        result: "success",
      });
    });

    it("keeps normal access to the other tables", async () => {
      const user = await db.user.create({ data: { email: "x@example.test" } });
      await db.user.update({ where: { id: user.id }, data: { name: "X" } });
      await db.user.delete({ where: { id: user.id } });
      expect(await db.user.count()).toBe(0);
    });

    it("cannot change the schema", async () => {
      await expect(rawAsApp("CREATE TABLE intruder (id int)")).rejects.toThrow(DENIED);
      await expect(rawAsApp('DROP TABLE "AuditLog"')).rejects.toThrow(
        /must be owner|permission denied/i,
      );
    });
  });

  describe("GET /audit", () => {
    async function seed() {
      const admin = await userWithSession(db, "ADMIN", { sessionSecret: SECRET, now: NOW });
      const developer = await userWithSession(db, "DEVELOPER", { sessionSecret: SECRET, now: NOW });
      const viewer = await userWithSession(db, "VIEWER", { sessionSecret: SECRET, now: NOW });
      await db.auditLog.createMany({
        data: [
          entry("auth.login", "2026-10-27T09:00:00Z", {
            userId: developer.user.id,
            ip: "203.0.113.1",
          }),
          entry("auth.login", "2026-10-28T09:00:00Z", { userId: admin.user.id, result: "failure" }),
          entry("deploy.start", "2026-10-28T10:00:00Z", {
            userId: admin.user.id,
            siteIds: ["site1"],
          }),
          entry("auth.logout", "2026-10-29T08:00:00Z", { userId: admin.user.id }),
        ],
      });
      return { admin, developer, viewer };
    }
    const list = (token: string, query = "") =>
      request(app)
        .get(`/audit${query}`)
        .set("authorization", `Bearer ${token}`)
        .set("x-ulix-client-ip", "198.51.100.9");

    it("needs a valid session", async () => {
      expect((await request(app).get("/audit")).status).toBe(401);
      expect((await request(app).get("/audit").set("authorization", "Bearer nope")).status).toBe(
        401,
      );
      const bogus = await list("a".repeat(43));
      expect([bogus.status, bogus.body]).toEqual([401, { error: "session_invalid" }]);
    });

    it("is Admin-only, and every refusal is itself audited", async () => {
      const { developer, viewer } = await seed();
      for (const who of [developer, viewer]) {
        const res = await list(who.token);
        expect([res.status, res.body]).toEqual([403, { error: "forbidden" }]);
      }
      const denials = await db.auditLog.findMany({ where: { action: "rbac.denied" } });
      expect(denials).toHaveLength(2);
      expect(denials[0]).toMatchObject({
        result: "denied",
        ip: "198.51.100.9",
        meta: { permission: "audit.view", method: "GET", path: "/audit" },
      });
    });

    it("lists entries newest first, with the user's email", async () => {
      const { admin } = await seed();
      const res = await list(admin.token);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual([
        "auth.logout",
        "deploy.start",
        "auth.login",
        "auth.login",
      ]);
      expect(res.body.entries[1]).toMatchObject({
        siteIds: ["site1"],
        user: { email: "admin@example.test" },
      });
    });

    it("filters by action prefix, result, email and UTC day range", async () => {
      const { admin } = await seed();
      const actions = async (query: string) =>
        (await list(admin.token, query)).body.entries.map(
          (e: { action: string; createdAt: string }) => `${e.action}@${e.createdAt.slice(0, 10)}`,
        );
      expect(await actions("?action=auth.")).toEqual([
        "auth.logout@2026-10-29",
        "auth.login@2026-10-28",
        "auth.login@2026-10-27",
      ]);
      expect(await actions("?result=failure")).toEqual(["auth.login@2026-10-28"]);
      expect(await actions("?email=DEVELOPER@example.test")).toEqual(["auth.login@2026-10-27"]);
      expect(await actions("?from=2026-10-28&to=2026-10-28")).toEqual([
        "deploy.start@2026-10-28",
        "auth.login@2026-10-28",
      ]);
      expect(await actions("?email=nobody@example.test")).toEqual([]);
    });

    it("pages with a cursor", async () => {
      const { admin } = await seed();
      const first = await list(admin.token, "?limit=3");
      expect(first.body.entries).toHaveLength(3);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await list(admin.token, `?limit=3&cursor=${first.body.nextCursor}`);
      expect(second.body.entries.map((e: { action: string }) => e.action)).toEqual(["auth.login"]);
      expect(second.body.nextCursor).toBeNull();
    });

    it("rejects malformed filters", async () => {
      const { admin } = await seed();
      for (const query of ["?limit=0", "?limit=500", "?from=yesterday", "?cursor=DROP%20TABLE"]) {
        expect((await list(admin.token, query)).status).toBe(400);
      }
    });
  });

  describe("GET /me", () => {
    it("returns the user and exactly their role's permissions", async () => {
      for (const role of ["ADMIN", "DEVELOPER", "VIEWER"] as const) {
        const { token } = await userWithSession(db, role, { sessionSecret: SECRET, now: NOW });
        const res = await request(app).get("/me").set("authorization", `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.user.role).toBe(role);
        expect(res.body.permissions).toEqual(ROLE_PERMISSIONS[role]);
        expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|totp|tokenHash/);
      }
    });
  });
});
