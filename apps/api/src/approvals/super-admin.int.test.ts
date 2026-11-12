// Super Admin (A134): risky actions are self-approved at once and every other Admin is alerted.
import { generateKeyPairSync } from "node:crypto";
import type { RunnerJob } from "@ulixops/shared";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import type { NotifyInput } from "../notifications/dispatch";
import type { SecurityAlertEvent } from "../notify";
import type { RunnerClient } from "../runner/client";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 31, 11, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;

const production = {
  url: "https://shop.example.test",
  sshHost: "shop.ssh.example.test",
  sshPort: 22,
  sshUser: "shop",
  wpPath: "/sites/shop",
  credentialRef: "SHOP_SSH_KEY",
};

describe.runIf(TEST_DATABASE_URL)("Super Admin self-approval (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  let notices: NotifyInput[] = [];
  const notifier = {
    alert: async (_event: SecurityAlertEvent) => undefined,
    notify: async (input: NotifyInput) => {
      notices.push(input);
    },
  };
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  let jobs: RunnerJob[] = [];
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      if (job.type === "credentials.list") return { credentials: [] };
      if (job.type === "secrets.publicKey")
        return { keyId: "0123456789abcdef0123456789abcdef", publicKey };
      if (job.type === "secrets.set") return { ok: true, updatedAt: NOW.toISOString() };
      throw new Error(`unexpected job ${job.type}`);
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
  const app = createApp({ auth, db, now, notifier, runner, sessionSecret: SECRET });

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (path: string) => set(request(app).get(path)),
      post: (path: string, body: object = {}) => set(request(app).post(path)).send(body),
      patch: (path: string, body: object) => set(request(app).patch(path)).send(body),
      put: (path: string, body: object) => set(request(app).put(path)).send(body),
    };
  };
  const make = (role: "SUPER_ADMIN" | "ADMIN", email: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, email });

  async function pinnedSite(token: string) {
    const res = await as(token)
      .post("/sites", { name: "Shop", host: "WPENGINE", tags: [], production, staging: null })
      .expect(201);
    const id = res.body.id as string;
    await db.siteEnvironment.updateMany({ where: { siteId: id }, data: { hostKey: KEY_A } });
    return id;
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    notices = [];
    jobs = [];
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("applies a Super Admin's risky change at once and alerts every other Admin", async () => {
    const boss = await make("SUPER_ADMIN", "boss@example.test");
    const other = await make("ADMIN", "other@example.test");
    const siteId = await pinnedSite(boss.token);

    const res = await as(boss.token)
      .post(`/sites/${siteId}/environments/production/host-key/reset`)
      .expect(202);
    expect(res.body).toEqual({ ok: true, selfApproved: true });
    const env = await db.siteEnvironment.findFirstOrThrow({ where: { siteId } });
    expect(env.hostKey).toBeNull();

    const approval = await db.approvalRequest.findFirstOrThrow();
    expect(approval).toMatchObject({
      status: "APPROVED",
      requestedById: boss.user.id,
      decidedById: boss.user.id,
      comment: "Self-approved (Super Admin)",
    });
    expect(
      await db.auditLog.findFirstOrThrow({ where: { action: "approval.self_approve" } }),
    ).toMatchObject({ userId: boss.user.id, siteIds: [siteId] });

    // Only the other Admin hears about it, and not as an "approval requested".
    expect(notices.map((n) => n.kind)).toEqual(["approval.self_approved"]);
    expect(notices[0]).toMatchObject({ recipientUserIds: [other.user.id], siteIds: [siteId] });
    expect(notices[0]?.body).toContain("boss@example.test approved their own request");

    // The Approvals history shows it as decided by the requester.
    const list = await as(other.token).get("/approvals").expect(200);
    expect(list.body.recent[0]).toMatchObject({
      status: "APPROVED",
      requestedBy: { email: "boss@example.test" },
      decidedBy: { email: "boss@example.test" },
    });
  });

  it("archives a site at once for a Super Admin but not for an Admin", async () => {
    const boss = await make("SUPER_ADMIN", "boss@example.test");
    const admin = await make("ADMIN", "admin@example.test");
    const siteA = await pinnedSite(boss.token);
    expect((await as(boss.token).post(`/sites/${siteA}/archive`).expect(200)).body).toMatchObject({
      selfApproved: true,
    });
    expect((await db.site.findUniqueOrThrow({ where: { id: siteA } })).archived).toBe(true);

    const siteB = (
      await as(admin.token)
        .post("/sites", {
          name: "Other",
          host: "WPENGINE",
          tags: [],
          production: { ...production, url: "https://other.example.test" },
          staging: null,
        })
        .expect(201)
    ).body.id as string;
    expect((await as(admin.token).post(`/sites/${siteB}/archive`).expect(200)).body).toMatchObject({
      selfApproved: false,
    });
    expect((await db.site.findUniqueOrThrow({ where: { id: siteB } })).archived).toBe(false);
  });

  it("lets a Super Admin set an API key without waiting", async () => {
    const boss = await make("SUPER_ADMIN", "boss@example.test");
    await make("ADMIN", "other@example.test");
    const path = "/credentials/api-keys/wordfence_api_key";
    const req = await as(boss.token).post(`${path}/request`).expect(201);
    expect(req.body.selfApproved).toBe(true);
    await as(boss.token)
      .put(path, { approvalId: req.body.id, value: "wf_live_0123456789abcdef" })
      .expect(200);
    expect(jobs.map((j) => j.type)).toContain("secrets.set");
  });

  it("can't be given through the API, and only a Super Admin can change one", async () => {
    const boss = await make("SUPER_ADMIN", "boss@example.test");
    const admin = await make("ADMIN", "admin@example.test");
    const second = await make("ADMIN", "second@example.test");

    await as(admin.token)
      .post("/users", { email: "new@example.test", role: "SUPER_ADMIN" })
      .expect(400);
    await as(admin.token).patch(`/users/${second.user.id}`, { role: "SUPER_ADMIN" }).expect(400);

    await as(admin.token).patch(`/users/${boss.user.id}`, { active: false }).expect(403);
    await as(admin.token).patch(`/users/${boss.user.id}`, { role: "VIEWER" }).expect(403);
    await as(admin.token).post(`/users/${boss.user.id}/reset-2fa`).expect(403);

    // A Super Admin can still manage Admins, and counts as an Admin for the last-Admin rule.
    await as(boss.token).patch(`/users/${second.user.id}`, { active: false }).expect(200);
    await as(boss.token).patch(`/users/${admin.user.id}`, { role: "VIEWER" }).expect(200);
  });
});
