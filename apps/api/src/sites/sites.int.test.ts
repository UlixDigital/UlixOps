// Site registry, approvals and credentials through the HTTP routes (real Postgres, stub runner).
import type { RunnerJob, SiteTestResult } from "@ulixops/shared";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import type { SecurityAlertEvent } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 29, 12, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;
const KEY_B = `SHA256:${"B".repeat(43)}`;

const production = {
  url: "https://shop.example.test",
  sshHost: "shop.ssh.example.test",
  sshPort: 22,
  sshUser: "shop",
  wpPath: "/sites/shop",
  credentialRef: "SHOP_SSH_KEY",
};

function testResult(overrides: Partial<SiteTestResult> = {}): SiteTestResult {
  return {
    ok: true,
    steps: [
      { name: "vault", ok: true, detail: "Key found" },
      { name: "ssh", ok: true, detail: "Connected" },
      { name: "wp-cli", ok: true, detail: "WP-CLI 2.12.0" },
      { name: "wordpress", ok: true, detail: "WordPress 6.9" },
    ],
    hostKey: KEY_A,
    hostKeyMismatch: false,
    wpVersion: "6.9",
    phpVersion: "8.3.14",
    wpCliVersion: "2.12.0",
    durationMs: 900,
    ...overrides,
  };
}

describe.runIf(TEST_DATABASE_URL)("sites, approvals and credentials (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  let alerts: SecurityAlertEvent[] = [];
  const notifier = {
    alert: async (event: SecurityAlertEvent) => {
      alerts.push(event);
    },
  };
  // The stub answers each job with whatever the test queued up, and records what was sent.
  let jobs: RunnerJob[] = [];
  let answer: (job: RunnerJob) => Promise<unknown> = async () => ({});
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      return answer(job);
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
    runner,
    sessionSecret: SECRET,
    publicUrl: "https://ulixops.example.test",
    envAllowedIps: [],
  });

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
  const make = (role: "ADMIN" | "DEVELOPER" | "VIEWER", email?: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, ...(email ? { email } : {}) });
  const lastAudit = (action: string) =>
    db.auditLog.findFirst({ where: { action }, orderBy: { createdAt: "desc" } });
  const productionEnv = (siteId: string) =>
    db.siteEnvironment.findUniqueOrThrow({
      where: { siteId_kind: { siteId, kind: "PRODUCTION" } },
    });

  async function createSite(token: string, body: object = {}) {
    const res = await as(token)
      .post("/sites", {
        name: "Shop",
        host: "WPENGINE",
        tags: ["client a"],
        production,
        staging: null,
        ...body,
      })
      .expect(201);
    return res.body.id as string;
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    alerts = [];
    jobs = [];
    answer = async () => ({});
  });
  afterAll(() => db.$disconnect());

  describe("registry", () => {
    it("lets an Admin register a site and anyone signed in see it", async () => {
      const admin = await make("ADMIN");
      const viewer = await make("VIEWER");
      const id = await createSite(admin.token);

      const list = await as(viewer.token).get("/sites").expect(200);
      expect(list.body.sites).toHaveLength(1);
      expect(list.body.sites[0]).toMatchObject({
        id,
        name: "Shop",
        url: production.url,
        tags: ["client a"],
        pendingApprovals: 0,
        environments: [{ kind: "PRODUCTION", credentialRef: "SHOP_SSH_KEY", hostKey: null }],
      });
      expect(await lastAudit("site.create")).toMatchObject({
        userId: admin.user.id,
        siteIds: [id],
      });
    });

    it("refuses Viewers and Developers, duplicate URLs and unsafe values", async () => {
      const admin = await make("ADMIN");
      const dev = await make("DEVELOPER");
      await as(dev.token)
        .post("/sites", { name: "X", host: "OTHER", tags: [], production, staging: null })
        .expect(403);
      await createSite(admin.token);
      const dup = await as(admin.token)
        .post("/sites", { name: "Again", host: "OTHER", tags: [], production, staging: null })
        .expect(409);
      expect(dup.body.error).toBe("url_taken");

      for (const bad of [
        { wpPath: "/sites/../etc" },
        { sshHost: "-oProxyCommand=sh" },
        { sshUser: "root;id" },
        { credentialRef: "lower-case" },
        { url: "javascript:alert(1)" },
      ]) {
        await as(admin.token)
          .post("/sites", {
            name: "Bad",
            host: "OTHER",
            tags: [],
            production: { ...production, url: "https://other.example.test", ...bad },
            staging: null,
          })
          .expect(400);
      }
      expect(await db.site.count()).toBe(1);
    });

    it("applies name, tags, URL and WordPress path at once, and archives and restores", async () => {
      const admin = await make("ADMIN");
      const id = await createSite(admin.token);
      const res = await as(admin.token)
        .patch(`/sites/${id}`, {
          name: "Shop (EU)",
          tags: ["eu"],
          production: { ...production, url: "https://eu.shop.example.test", wpPath: "/sites/eu" },
        })
        .expect(200);
      expect(res.body.approvalsRequested).toEqual([]);
      expect(res.body.site).toMatchObject({
        name: "Shop (EU)",
        url: "https://eu.shop.example.test",
      });
      expect((await productionEnv(id)).wpPath).toBe("/sites/eu");

      const archive = await as(admin.token).post(`/sites/${id}/archive`).expect(200);
      expect(archive.body.approvalId).toMatch(/^[a-z0-9]+$/);
      // Not archived until another Admin approves.
      expect((await as(admin.token).get("/sites").expect(200)).body.sites).toHaveLength(1);
      const approver = await make("ADMIN", "approver-archive@example.test");
      await as(approver.token)
        .post(`/approvals/${archive.body.approvalId}/approve`, { comment: "OK" })
        .expect(200);
      expect((await as(admin.token).get("/sites").expect(200)).body.sites).toHaveLength(0);
      expect((await as(admin.token).get("/sites?archived=1").expect(200)).body.sites).toHaveLength(
        1,
      );
      await as(admin.token).post(`/sites/${id}/restore`).expect(200);
      expect(await lastAudit("site.restore")).toMatchObject({ siteIds: [id] });
    });

    it("adds and removes staging without approval", async () => {
      const admin = await make("ADMIN");
      const id = await createSite(admin.token);
      const staging = {
        ...production,
        url: "https://staging.shop.example.test",
        sshUser: "shopstg",
      };
      await as(admin.token).patch(`/sites/${id}`, { staging }).expect(200);
      expect(await db.siteEnvironment.count({ where: { siteId: id } })).toBe(2);
      await as(admin.token).patch(`/sites/${id}`, { staging: null }).expect(200);
      expect(await db.siteEnvironment.count({ where: { siteId: id } })).toBe(1);
    });
  });

  describe("connection changes need a second Admin", () => {
    it("queues a new SSH key instead of applying it, once", async () => {
      const admin = await make("ADMIN");
      const id = await createSite(admin.token);
      const change = { production: { ...production, credentialRef: "SHOP_SSH_KEY_2" } };
      const res = await as(admin.token).patch(`/sites/${id}`, change).expect(200);
      expect(res.body.approvalsRequested).toEqual(["production connection"]);
      expect(res.body.site.pendingApprovals).toBe(1);
      expect((await productionEnv(id)).credentialRef).toBe("SHOP_SSH_KEY");

      const again = await as(admin.token).patch(`/sites/${id}`, change).expect(200);
      expect(again.body.approvalsRequested).toEqual(["production connection (already waiting)"]);
      expect(await db.approvalRequest.count()).toBe(1);
      expect(await lastAudit("approval.request")).toMatchObject({
        result: "pending",
        siteIds: [id],
      });
    });

    it("never lets the requester approve, and applies once another Admin does", async () => {
      const requester = await make("ADMIN", "a@example.test");
      const approver = await make("ADMIN", "b@example.test");
      const id = await createSite(requester.token);
      await db.siteEnvironment.updateMany({
        where: { siteId: id },
        data: { hostKey: KEY_A, lastTestOk: true },
      });
      await as(requester.token)
        .patch(`/sites/${id}`, { production: { ...production, sshHost: "new.ssh.example.test" } })
        .expect(200);

      const list = await as(approver.token).get("/approvals").expect(200);
      expect(list.body.pending).toHaveLength(1);
      const [pending] = list.body.pending;
      expect(pending.summary).toBe(
        "Shop (production): server shop.ssh.example.test:22 → new.ssh.example.test:22",
      );
      expect(pending.ownRequest).toBe(false);

      const own = await as(requester.token).post(`/approvals/${pending.id}/approve`).expect(409);
      expect(own.body.error).toBe("own_request");

      await as(approver.token)
        .post(`/approvals/${pending.id}/approve`, { comment: "Moved hosts" })
        .expect(200);
      const env = await productionEnv(id);
      // A new server means the old pinned key no longer applies; re-test before use.
      expect(env).toMatchObject({
        sshHost: "new.ssh.example.test",
        hostKey: null,
        lastTestOk: null,
      });
      expect(await lastAudit("approval.approve")).toMatchObject({
        userId: approver.user.id,
        siteIds: [id],
      });
      const again = await as(approver.token).post(`/approvals/${pending.id}/approve`).expect(409);
      expect(again.body.error).toBe("already_decided");
    });

    it("refuses Developers, and closes a request the site has moved past", async () => {
      const requester = await make("ADMIN", "a@example.test");
      const approver = await make("ADMIN", "b@example.test");
      const dev = await make("DEVELOPER");
      const id = await createSite(requester.token);
      await as(requester.token)
        .patch(`/sites/${id}`, { production: { ...production, sshUser: "deploy" } })
        .expect(200);
      const request = await db.approvalRequest.findFirstOrThrow();
      await as(dev.token).get("/approvals").expect(403);
      await as(dev.token).post(`/approvals/${request.id}/approve`).expect(403);

      // Someone changed the user another way (here: directly) before the decision.
      await db.siteEnvironment.updateMany({ where: { siteId: id }, data: { sshUser: "other" } });
      const res = await as(approver.token).post(`/approvals/${request.id}/approve`).expect(409);
      expect(res.body.error).toBe("out_of_date");
      expect((await productionEnv(id)).sshUser).toBe("other");
      expect(
        await db.approvalRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({
        status: "REJECTED",
      });
    });

    it("records a rejection without changing the site", async () => {
      const requester = await make("ADMIN", "a@example.test");
      const approver = await make("ADMIN", "b@example.test");
      const id = await createSite(requester.token);
      await as(requester.token)
        .patch(`/sites/${id}`, { production: { ...production, sshPort: 2222 } })
        .expect(200);
      const request = await db.approvalRequest.findFirstOrThrow();
      await as(approver.token)
        .post(`/approvals/${request.id}/reject`, { comment: "No" })
        .expect(200);
      expect((await productionEnv(id)).sshPort).toBe(22);
      expect(await lastAudit("approval.reject")).toMatchObject({ userId: approver.user.id });
    });
  });

  describe("test connection", () => {
    it("sends the stored target, saves versions and pins the host key on first success", async () => {
      const admin = await make("ADMIN");
      const id = await createSite(admin.token);
      answer = async () => testResult();
      const res = await as(admin.token)
        .post(`/sites/${id}/environments/production/test`)
        .expect(200);
      expect(res.body).toMatchObject({ ok: true, hostKeyPinned: true, wpVersion: "6.9" });
      expect(jobs).toEqual([
        {
          type: "site.test",
          target: {
            host: production.sshHost,
            port: 22,
            user: "shop",
            wpPath: "/sites/shop",
            credentialRef: "SHOP_SSH_KEY",
            hostKey: null,
          },
          wpPathCandidates: ["/home/wpe-user/sites/shop"],
        },
      ]);
      expect(await productionEnv(id)).toMatchObject({
        hostKey: KEY_A,
        lastTestOk: true,
        lastTestError: null,
        phpVersion: "8.3.14",
        wpCliVersion: "2.12.0",
      });
      expect(await lastAudit("site.test")).toMatchObject({ result: "success", siteIds: [id] });

      // Later tests send the pin, and don't re-pin.
      const second = await as(admin.token)
        .post(`/sites/${id}/environments/production/test`)
        .expect(200);
      expect(second.body.hostKeyPinned).toBe(false);
      expect(jobs[1]).toMatchObject({ target: { hostKey: KEY_A } });
    });

    it("raises an alert on a host key mismatch and keeps the old pin", async () => {
      const admin = await make("ADMIN");
      const id = await createSite(admin.token);
      await db.siteEnvironment.updateMany({ where: { siteId: id }, data: { hostKey: KEY_A } });
      answer = async () =>
        testResult({
          ok: false,
          hostKey: KEY_B,
          hostKeyMismatch: true,
          steps: [
            { name: "vault", ok: true, detail: "Key found" },
            { name: "ssh", ok: false, detail: "Host key changed" },
          ],
        });
      const res = await as(admin.token)
        .post(`/sites/${id}/environments/production/test`)
        .expect(200);
      expect(res.body).toMatchObject({ ok: false, hostKeyMismatch: true, hostKeyPinned: false });
      expect(await productionEnv(id)).toMatchObject({
        hostKey: KEY_A,
        lastTestOk: false,
        lastTestError: "Host key changed",
        wpVersion: null,
      });
      expect(alerts.map((a) => a.kind)).toEqual(["HOST_KEY_MISMATCH"]);
      expect(await lastAudit("site.test")).toMatchObject({ result: "failure" });
    });

    it("maps runner problems to clear errors, and refuses Developers and unknown environments", async () => {
      const admin = await make("ADMIN");
      const dev = await make("DEVELOPER");
      const id = await createSite(admin.token);
      await as(dev.token).post(`/sites/${id}/environments/production/test`).expect(403);
      await as(admin.token).post(`/sites/${id}/environments/staging/test`).expect(404);
      await as(admin.token).post(`/sites/${id}/environments/nope/test`).expect(404);
      await as(admin.token).post(`/sites/missing/environments/production/test`).expect(404);

      answer = async () => {
        throw new RunnerUnavailableError("The runner did not answer in time");
      };
      const down = await as(admin.token)
        .post(`/sites/${id}/environments/production/test`)
        .expect(504);
      expect(down.body.error).toBe("runner_unavailable");
      answer = async () => {
        throw new RunnerJobFailedError("Vault unavailable");
      };
      const failed = await as(admin.token)
        .post(`/sites/${id}/environments/production/test`)
        .expect(502);
      expect(failed.body).toEqual({ error: "runner_failed", detail: "Vault unavailable" });
      expect(jobs).toHaveLength(2);
    });

    it("forgets a pinned host key only after a second Admin approves", async () => {
      const requester = await make("ADMIN", "a@example.test");
      const approver = await make("ADMIN", "b@example.test");
      const id = await createSite(requester.token);
      await as(requester.token)
        .post(`/sites/${id}/environments/production/host-key/reset`)
        .expect(404);
      await db.siteEnvironment.updateMany({ where: { siteId: id }, data: { hostKey: KEY_A } });

      await as(requester.token)
        .post(`/sites/${id}/environments/production/host-key/reset`)
        .expect(202);
      const dup = await as(requester.token)
        .post(`/sites/${id}/environments/production/host-key/reset`)
        .expect(409);
      expect(dup.body.error).toBe("already_pending");
      expect((await productionEnv(id)).hostKey).toBe(KEY_A);

      const request = await db.approvalRequest.findFirstOrThrow();
      await as(approver.token).post(`/approvals/${request.id}/approve`).expect(200);
      expect((await productionEnv(id)).hostKey).toBeNull();
    });
  });

  describe("credentials", () => {
    it("lists vault names with age, rotation and the sites using them", async () => {
      const admin = await make("ADMIN");
      const id = await createSite(admin.token);
      answer = async () => ({
        credentials: [
          {
            name: "SHOP_SSH_KEY",
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
          {
            name: "NEW_KEY",
            createdAt: "2026-10-20T00:00:00.000Z",
            updatedAt: "2026-10-20T00:00:00.000Z",
          },
        ],
      });
      const res = await as(admin.token).get("/credentials").expect(200);
      expect(jobs).toEqual([{ type: "credentials.list" }]);
      expect(res.body.credentials).toEqual([
        expect.objectContaining({
          name: "SHOP_SSH_KEY",
          ageDays: 150,
          rotationDue: true,
          usedBy: [{ siteId: id, siteName: "Shop", kind: "PRODUCTION" }],
        }),
        expect.objectContaining({ name: "NEW_KEY", ageDays: 9, rotationDue: false, usedBy: [] }),
      ]);
    });

    it("creates a key through the runner and returns only the public half", async () => {
      const admin = await make("ADMIN");
      const dev = await make("DEVELOPER");
      await as(dev.token).get("/credentials").expect(403);
      await as(dev.token).post("/credentials", { name: "SHOP_SSH_KEY" }).expect(403);
      await as(admin.token).post("/credentials", { name: "bad name" }).expect(400);
      expect(jobs).toEqual([]);

      answer = async () => ({
        name: "SHOP_SSH_KEY",
        publicKey: "ssh-ed25519 AAAAC3Nza ulixops:SHOP_SSH_KEY",
      });
      const res = await as(admin.token).post("/credentials", { name: "SHOP_SSH_KEY" }).expect(201);
      expect(res.body).toEqual({
        name: "SHOP_SSH_KEY",
        publicKey: "ssh-ed25519 AAAAC3Nza ulixops:SHOP_SSH_KEY",
      });
      expect(jobs).toEqual([{ type: "credentials.create", name: "SHOP_SSH_KEY" }]);
      expect(await lastAudit("credential.create")).toMatchObject({
        userId: admin.user.id,
        meta: { name: "SHOP_SSH_KEY" },
      });

      answer = async () => {
        throw new RunnerJobFailedError("A secret named SHOP_SSH_KEY already exists");
      };
      const taken = await as(admin.token)
        .post("/credentials", { name: "SHOP_SSH_KEY" })
        .expect(409);
      expect(taken.body.error).toBe("name_taken");
    });
  });

  describe("Client Viewer tag scope (A178)", () => {
    it("lists only matching sites, 404s others, and cannot scan", async () => {
      const admin = await make("ADMIN");
      const client = await userWithSession(db, "CLIENT_VIEWER", {
        sessionSecret: SECRET,
        now: NOW,
        email: "client@example.test",
        viewTag: "client a",
      });
      const matching = await createSite(admin.token, {
        name: "Match",
        tags: ["client a"],
        production: { ...production, url: "https://match.example.test", sshHost: "match.ssh" },
      });
      const other = await createSite(admin.token, {
        name: "Other",
        tags: ["other"],
        production: {
          ...production,
          url: "https://other.example.test",
          sshHost: "other.ssh",
          credentialRef: "OTHER_SSH_KEY",
        },
      });

      const list = await as(client.token).get("/sites").expect(200);
      expect(list.body.sites.map((s: { id: string }) => s.id)).toEqual([matching]);

      await as(client.token).get(`/sites/${matching}`).expect(200);
      await as(client.token).get(`/sites/${other}`).expect(404);

      const malware = await as(client.token).get("/malware-scans/overview").expect(200);
      expect(malware.body.sites.map((s: { siteId: string }) => s.siteId)).toEqual([matching]);

      await as(client.token)
        .post(`/sites/${matching}/environments/production/malware-scan`, {})
        .expect(403);
      await as(client.token).put("/malware-scans/schedule", {}).expect(403);

      const session = await request(app)
        .post("/auth/session")
        .send({ sessionToken: client.token })
        .expect(200);
      expect(session.body.user).toMatchObject({
        role: "CLIENT_VIEWER",
        viewTag: "client a",
      });
    });
  });
});
