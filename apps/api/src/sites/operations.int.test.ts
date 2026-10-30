// Site detail: inventory, plugin and emergency actions, job logs (real Postgres, stub runner).
import type { RunnerJob, SiteInventoryResult } from "@ulixops/shared";
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

function inventory(overrides: Partial<SiteInventoryResult & { hostKeyMismatch: false }> = {}) {
  return {
    hostKeyMismatch: false,
    hostKey: KEY_A,
    wpVersion: "6.9.1",
    phpVersion: "8.3.14",
    wpCliVersion: "2.12.0",
    plugins: [
      { name: "akismet", title: "Akismet", status: "active", version: "5.3", updateVersion: "5.4" },
      {
        name: "hello",
        title: "Hello Dolly",
        status: "inactive",
        version: "1.7.2",
        updateVersion: null,
      },
    ],
    themes: [
      {
        name: "twentytwentyfive",
        title: "TT5",
        status: "active",
        version: "1.5",
        updateVersion: null,
      },
      {
        name: "twentytwentyfour",
        title: "TT4",
        status: "inactive",
        version: "1.2",
        updateVersion: "1.3",
      },
    ],
    maintenance: false,
    safeMode: false,
    warnings: [],
    durationMs: 1200,
    ...overrides,
  };
}

const commandResult = (exitCode = 0, stdout = "Success: done.", stderr = "") => ({
  hostKeyMismatch: false,
  exitCode,
  stdout,
  stderr,
  hostKey: KEY_A,
  durationMs: 300,
});

describe.runIf(TEST_DATABASE_URL)("site inventory, actions and job logs (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  let alerts: SecurityAlertEvent[] = [];
  const notifier = {
    alert: async (event: SecurityAlertEvent) => {
      alerts.push(event);
    },
  };
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
  const app = createApp({ auth, db, now, notifier, runner, sessionSecret: SECRET });

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (path: string) => set(request(app).get(path)),
      post: (path: string, body: object = {}) => set(request(app).post(path)).send(body),
    };
  };
  const make = (role: "ADMIN" | "DEVELOPER" | "VIEWER", email?: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, ...(email ? { email } : {}) });
  const lastAudit = (action: string) =>
    db.auditLog.findFirst({ where: { action }, orderBy: { createdAt: "desc" } });

  /** A registered site whose production host key is pinned (Test connection passed). */
  async function testedSite(admin: string, opts: { pin?: boolean } = {}) {
    const res = await as(admin)
      .post("/sites", { name: "Shop", host: "WPENGINE", tags: [], production, staging: null })
      .expect(201);
    const id = res.body.id as string;
    if (opts.pin !== false)
      await db.siteEnvironment.updateMany({ where: { siteId: id }, data: { hostKey: KEY_A } });
    return id;
  }
  const refresh = (token: string, id: string, kind = "production") =>
    as(token).post(`/sites/${id}/environments/${kind}/inventory`);
  const act = (token: string, id: string, body: object, kind = "production") =>
    as(token).post(`/sites/${id}/environments/${kind}/actions`, body);

  beforeEach(async () => {
    await resetData(ownerUrl);
    alerts = [];
    jobs = [];
    answer = async () => ({});
  });
  afterAll(() => db.$disconnect());

  describe("inventory", () => {
    it("lets a Developer refresh it and anyone signed in read it", async () => {
      const admin = await make("ADMIN");
      const dev = await make("DEVELOPER");
      const viewer = await make("VIEWER");
      const id = await testedSite(admin.token);
      answer = async () => inventory();

      const res = await refresh(dev.token, id).expect(200);
      expect(jobs).toEqual([
        {
          type: "site.inventory",
          checkUpdates: false,
          target: {
            host: production.sshHost,
            port: 22,
            user: "shop",
            wpPath: "/sites/shop",
            credentialRef: "SHOP_SSH_KEY",
            hostKey: KEY_A,
          },
        },
      ]);
      expect(res.body).toMatchObject({
        hostKeyMismatch: false,
        job: {
          action: "inventory.refresh",
          summary: "Refresh inventory",
          status: "SUCCEEDED",
          kind: "PRODUCTION",
          requestedBy: { email: "developer@example.test" },
        },
        inventory: { wpVersion: "6.9.1", activeTheme: "twentytwentyfive", maintenance: false },
      });
      expect(res.body.job.output).toContain("2 plugins (1 with updates), 2 themes");

      const read = await as(viewer.token).get(`/sites/${id}/environments/production/inventory`);
      expect(read.status).toBe(200);
      expect(read.body.inventory.plugins).toHaveLength(2);
      expect(read.body.inventory.refreshedBy).toMatchObject({ email: "developer@example.test" });

      // The overview and the sites list get the summary and the versions.
      const site = await as(viewer.token).get(`/sites/${id}`).expect(200);
      expect(site.body.environments[0]).toMatchObject({
        wpVersion: "6.9.1",
        phpVersion: "8.3.14",
        inventory: {
          plugins: 2,
          pluginUpdates: 1,
          themeUpdates: 1,
          activeTheme: "twentytwentyfive",
        },
      });
      expect(await lastAudit("site.inventory.refresh")).toMatchObject({
        userId: dev.user.id,
        result: "success",
        siteIds: [id],
      });
    });

    it("answers null before the first refresh and replaces it on the next", async () => {
      const admin = await make("ADMIN");
      const id = await testedSite(admin.token);
      const before = await as(admin.token).get(`/sites/${id}/environments/production/inventory`);
      expect(before.body).toEqual({ inventory: null });

      answer = async () => inventory();
      await refresh(admin.token, id).expect(200);
      answer = async () => inventory({ safeMode: true, plugins: [], warnings: ["Fatal error"] });
      const res = await refresh(admin.token, id).expect(200);
      expect(res.body.inventory).toMatchObject({
        safeMode: true,
        plugins: [],
        warnings: ["Fatal error"],
      });
      expect(res.body.job.output).toContain("plugins and themes skipped");
      expect(await db.siteInventory.count()).toBe(1);
    });

    it("refuses Viewers, untested connections, archived sites and a busy site", async () => {
      const admin = await make("ADMIN");
      const viewer = await make("VIEWER");
      const id = await testedSite(admin.token);
      answer = async () => inventory();

      await refresh(viewer.token, id).expect(403);
      expect(await lastAudit("rbac.denied")).toMatchObject({ userId: viewer.user.id });

      const untested = await as(admin.token)
        .post("/sites", {
          name: "New",
          host: "OTHER",
          tags: [],
          production: { ...production, url: "https://new.example.test" },
          staging: null,
        })
        .expect(201);
      const notTested = await refresh(admin.token, untested.body.id as string).expect(409);
      expect(notTested.body).toEqual({ error: "connection_untested" });

      await refresh(admin.token, id, "staging").expect(404);
      await refresh(admin.token, "nope!").expect(404);

      const env = await db.siteEnvironment.findFirstOrThrow({ where: { siteId: id } });
      await db.siteEnvironmentLock.create({
        data: { environmentId: env.id, token: "held-by-another-request", lockedAt: NOW },
      });
      expect((await refresh(admin.token, id).expect(409)).body).toEqual({ error: "site_busy" });
      expect((await act(admin.token, id, { action: "cache.flush" }).expect(409)).body).toEqual({
        error: "site_busy",
      });
      // The refused requests left the other request's claim alone.
      expect(
        await db.siteEnvironmentLock.findUnique({ where: { environmentId: env.id } }),
      ).toMatchObject({
        token: "held-by-another-request",
      });
      await db.siteEnvironmentLock.deleteMany();

      const archive = await as(admin.token).post(`/sites/${id}/archive`).expect(200);
      const approver = await make("ADMIN", "approver-ops@example.test");
      await as(approver.token)
        .post(`/approvals/${archive.body.approvalId}/approve`, {})
        .expect(200);
      expect((await refresh(admin.token, id).expect(409)).body).toEqual({ error: "site_archived" });
      expect(jobs).toEqual([]);
    });

    it("doesn't let a job the API never finished block the site forever", async () => {
      const admin = await make("ADMIN");
      const id = await testedSite(admin.token);
      const env = await db.siteEnvironment.findFirstOrThrow({ where: { siteId: id } });
      const tenMinutesAgo = new Date(NOW.getTime() - 10 * 60_000);
      // What a crash mid-job leaves behind: a RUNNING job and its claim on the environment.
      await db.siteJob.create({
        data: {
          siteId: id,
          environmentId: env.id,
          action: "cache.flush",
          params: {},
          startedAt: tenMinutesAgo,
        },
      });
      await db.siteEnvironmentLock.create({
        data: { environmentId: env.id, token: "crashed", lockedAt: tenMinutesAgo },
      });
      answer = async () => inventory();
      await refresh(admin.token, id).expect(200);
      // Taken over, then released when this job finished.
      expect(await db.siteEnvironmentLock.count()).toBe(0);
      const log = await as(admin.token).get(`/sites/${id}/jobs`).expect(200);
      expect(
        log.body.jobs.map((j: { action: string; interrupted: boolean }) => [
          j.action,
          j.interrupted,
        ]),
      ).toEqual([
        ["inventory.refresh", false],
        ["cache.flush", true],
      ]);
    });
  });

  it("lets only one of two simultaneous requests run on an environment", async () => {
    const admin = await make("ADMIN");
    const id = await testedSite(admin.token);
    // Hold the first job inside the runner until both requests have arrived.
    let letGo: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    answer = async () => {
      await held;
      return commandResult();
    };
    const first = act(admin.token, id, { action: "cache.flush" }).then((r) => r);
    const second = act(admin.token, id, { action: "maintenance", on: true }).then((r) => r);
    // Whichever loses the claim answers at once; then the winner may finish.
    const loser = await Promise.race([first, second]);
    letGo();
    const statuses = [(await first).status, (await second).status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(loser.status).toBe(409);
    expect(loser.body).toEqual({ error: "site_busy" });
    expect(jobs).toHaveLength(1);
    expect(await db.siteJob.count()).toBe(1);
    // Released afterwards: the next request runs.
    await act(admin.token, id, { action: "cache.flush" }).expect(200);
  });

  it("releases the claim when a job fails unexpectedly", async () => {
    const admin = await make("ADMIN");
    const id = await testedSite(admin.token);
    answer = async () => ({ not: "a runner answer" });
    await act(admin.token, id, { action: "cache.flush" }).expect(500);
    expect(await db.siteEnvironmentLock.count()).toBe(0);
    answer = async () => commandResult();
    await act(admin.token, id, { action: "cache.flush" }).expect(200);
  });

  describe("actions", () => {
    it("runs an emergency deactivate with plugins skipped and keeps the inventory in step", async () => {
      const admin = await make("ADMIN");
      const dev = await make("DEVELOPER");
      const id = await testedSite(admin.token);
      answer = async () => inventory();
      await refresh(dev.token, id).expect(200);

      jobs = [];
      answer = async () => commandResult(0, "Plugin 'akismet' deactivated.");
      const res = await act(dev.token, id, {
        action: "plugin.deactivate",
        plugin: "akismet",
        emergency: true,
      }).expect(200);
      expect(jobs).toEqual([
        expect.objectContaining({
          type: "remote.command",
          command: { op: "plugin.deactivate", slug: "akismet", safe: true },
        }),
      ]);
      expect(res.body).toMatchObject({
        hostKeyMismatch: false,
        job: {
          action: "plugin.deactivate",
          summary: "Deactivate akismet (emergency, plugins skipped)",
          status: "SUCCEEDED",
          exitCode: 0,
          output: "Plugin 'akismet' deactivated.",
        },
      });
      const inv = await as(dev.token).get(`/sites/${id}/environments/production/inventory`);
      expect(inv.body.inventory.plugins[0]).toMatchObject({ name: "akismet", status: "inactive" });
      expect(await lastAudit("site.plugin.deactivate")).toMatchObject({
        userId: dev.user.id,
        result: "success",
        meta: { kind: "PRODUCTION", plugin: "akismet", emergency: true, exitCode: 0 },
      });
    });

    it("maps each action to its allowlisted command", async () => {
      const admin = await make("ADMIN");
      const id = await testedSite(admin.token);
      answer = async () => commandResult();
      for (const body of [
        { action: "plugin.activate", plugin: "js_composer" },
        { action: "plugin.deactivate", plugin: "hello" },
        { action: "maintenance", on: true },
        { action: "maintenance", on: false },
        { action: "cache.flush" },
      ]) {
        await act(admin.token, id, body).expect(200);
      }
      expect(jobs.map((j) => (j.type === "remote.command" ? j.command : null))).toEqual([
        { op: "plugin.activate", slug: "js_composer" },
        { op: "plugin.deactivate", slug: "hello", safe: false },
        { op: "maintenance", on: true },
        { op: "maintenance", on: false },
        { op: "cache.flush" },
      ]);
      const maintenance = await db.auditLog.findMany({ where: { action: "site.maintenance" } });
      expect(maintenance.map((row) => (row.meta as { on: boolean }).on).sort()).toEqual([
        false,
        true,
      ]);
    });

    it("tracks maintenance mode in the inventory", async () => {
      const admin = await make("ADMIN");
      const id = await testedSite(admin.token);
      answer = async () => inventory();
      await refresh(admin.token, id).expect(200);
      answer = async () => commandResult();
      await act(admin.token, id, { action: "maintenance", on: true }).expect(200);
      const site = await as(admin.token).get(`/sites/${id}`).expect(200);
      expect(site.body.environments[0].inventory.maintenance).toBe(true);
    });

    it("refuses Viewers and anything that isn't a valid action", async () => {
      const admin = await make("ADMIN");
      const viewer = await make("VIEWER");
      const id = await testedSite(admin.token);
      answer = async () => commandResult();

      for (const body of [
        { action: "plugin.activate", plugin: "hello" },
        { action: "maintenance", on: true },
        { action: "cache.flush" },
      ]) {
        await act(viewer.token, id, body).expect(403);
      }
      for (const body of [
        { action: "plugin.deactivate", plugin: "--all" },
        { action: "plugin.activate", plugin: "hello; rm -rf /" },
        { action: "plugin.activate", plugin: "../../wp-config" },
        { action: "maintenance", on: "yes" },
        { action: "db.drop" },
        { action: "shell", command: "id" },
        {},
      ]) {
        await act(admin.token, id, body).expect(400);
      }
      await act(admin.token, id, { action: "cache.flush" }, "nowhere").expect(400);
      expect(jobs).toEqual([]);
    });

    it("records a failing command with its output", async () => {
      const admin = await make("ADMIN");
      const id = await testedSite(admin.token);
      answer = async () => commandResult(1, "", "Error: The 'nope' plugin could not be found.");
      const res = await act(admin.token, id, { action: "plugin.activate", plugin: "nope" }).expect(
        200,
      );
      expect(res.body.job).toMatchObject({
        status: "FAILED",
        exitCode: 1,
        output: "Error: The 'nope' plugin could not be found.",
      });
      expect(await lastAudit("site.plugin.activate")).toMatchObject({
        result: "failure",
        meta: { exitCode: 1 },
      });
    });

    it("refuses to act on a changed host key and alerts Admins", async () => {
      const admin = await make("ADMIN");
      const id = await testedSite(admin.token);
      answer = async () => ({ hostKeyMismatch: true, expected: KEY_A, presented: KEY_B });
      const res = await act(admin.token, id, { action: "cache.flush" }).expect(200);
      expect(res.body).toMatchObject({
        hostKeyMismatch: true,
        job: { status: "FAILED", exitCode: null },
      });
      expect(res.body.job.output).toMatch(/host key no longer matches/);
      expect(alerts.map((a) => a.kind)).toEqual(["HOST_KEY_MISMATCH"]);
      expect(await db.securityAlert.count({ where: { kind: "HOST_KEY_MISMATCH" } })).toBe(1);
      // The pinned key is untouched.
      const env = await db.siteEnvironment.findFirstOrThrow({ where: { siteId: id } });
      expect(env.hostKey).toBe(KEY_A);
    });

    it("keeps a job log entry when the runner is down or fails", async () => {
      const admin = await make("ADMIN");
      const id = await testedSite(admin.token);
      answer = async () => {
        throw new RunnerUnavailableError("timeout");
      };
      const down = await act(admin.token, id, { action: "cache.flush" }).expect(200);
      expect(down.body.job).toMatchObject({ status: "FAILED" });
      expect(down.body.job.output).toMatch(/may still have run/);

      answer = async () => {
        throw new RunnerJobFailedError('"SHOP_SSH_KEY" is not in the vault');
      };
      const failed = await refresh(admin.token, id).expect(200);
      expect(failed.body).toMatchObject({
        inventory: null,
        job: { status: "FAILED", output: '"SHOP_SSH_KEY" is not in the vault' },
      });
      expect(await lastAudit("site.inventory.refresh")).toMatchObject({
        result: "failure",
        meta: { error: "runner_failed" },
      });
    });

    it("rejects a malformed runner answer without storing it", async () => {
      const admin = await make("ADMIN");
      const id = await testedSite(admin.token);
      answer = async () => inventory({ plugins: [{ name: "x", status: "evil" }] } as never);
      await refresh(admin.token, id).expect(500);
      expect(await db.siteInventory.count()).toBe(0);
      const job = await db.siteJob.findFirstOrThrow();
      expect(job).toMatchObject({ status: "FAILED", output: "Internal error" });
    });
  });

  it("lists a site's job log for anyone who can see the site, newest first", async () => {
    const admin = await make("ADMIN");
    const viewer = await make("VIEWER");
    const id = await testedSite(admin.token);
    answer = async () => commandResult();
    await act(admin.token, id, { action: "maintenance", on: true }).expect(200);
    await act(admin.token, id, { action: "maintenance", on: false }).expect(200);

    const res = await as(viewer.token).get(`/sites/${id}/jobs`).expect(200);
    expect(res.body.jobs).toHaveLength(2);
    expect(res.body.jobs[0]).toMatchObject({
      summary: expect.stringMatching(/^Maintenance mode/),
      requestedBy: { email: "admin@example.test" },
      kind: "PRODUCTION",
    });
    await as(viewer.token).get(`/sites/${id}/jobs?limit=500`).expect(400);
    await as(viewer.token).get("/sites/missing/jobs").expect(404);
  });
});
