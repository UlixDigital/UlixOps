// WordPress core updates (A135): update → update-db → health → rollback on failure.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
import { SnapshotStore } from "./store";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 31, 12, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;

const production = {
  url: "https://core.example.test",
  sshHost: "core.ssh.example.test",
  sshPort: 22,
  sshUser: "core",
  wpPath: "/sites/core",
  credentialRef: "CORE_SSH_KEY",
};

const ok = (stdout = "") => ({
  hostKeyMismatch: false,
  exitCode: 0,
  stdout,
  stderr: "",
  hostKey: KEY_A,
  durationMs: 5,
});

const health = (healthy: boolean) => ({
  hostKeyMismatch: false,
  ok: healthy,
  hostKey: KEY_A,
  urls: [
    {
      url: "https://core.example.test/",
      role: "home",
      ok: healthy,
      status: healthy ? 200 : 500,
      durationMs: 50,
      detail: healthy ? "OK" : "HTTP 500",
      criticalText: !healthy,
    },
  ],
  errorLog: { checked: false, ok: true, skipped: true, detail: "off", fatalLines: 0 },
  thresholdMs: 5000,
  durationMs: 60,
  summary: healthy ? "Healthy" : "Homepage HTTP 500",
});

const inventory = (wpVersion: string, coreUpdateVersion: string | null) => ({
  hostKeyMismatch: false,
  hostKey: KEY_A,
  wpVersion,
  phpVersion: "8.3.1",
  wpCliVersion: "2.12.0",
  plugins: [],
  themes: [],
  maintenance: false,
  safeMode: false,
  warnings: [],
  durationMs: 5,
  updatesChecked: true,
  coreUpdateVersion,
});

describe.runIf(TEST_DATABASE_URL)("WordPress core update (Postgres)", () => {
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
  let jobs: RunnerJob[] = [];
  let answer: (job: RunnerJob) => Promise<unknown> = async () => ({});
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      return answer(job);
    },
  };
  let app: ReturnType<typeof createApp>;
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

  beforeEach(async () => {
    await resetData(ownerUrl);
    notices = [];
    jobs = [];
    const storeDir = await mkdtemp(path.join(tmpdir(), "ulixops-core-"));
    app = createApp({
      auth,
      db,
      now,
      notifier,
      runner,
      sessionSecret: SECRET,
      snapshotStore: new SnapshotStore(storeDir),
      defaultRetentionDays: 7,
    });
  });
  afterAll(() => db.$disconnect());

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (p: string) => set(request(app).get(p)),
      post: (p: string, body: object = {}) => set(request(app).post(p)).send(body),
    };
  };
  const PATH = (siteId: string) => `/sites/${siteId}/environments/production/core/update`;

  async function siteOn(wpVersion: string, offered: string | null) {
    const admin = await userWithSession(db, "ADMIN", { sessionSecret: SECRET, now: NOW });
    const created = await as(admin.token)
      .post("/sites", { name: "Core Site", host: "OTHER", tags: [], production, staging: null })
      .expect(201);
    const siteId = created.body.id as string;
    await db.siteEnvironment.updateMany({ where: { siteId }, data: { hostKey: KEY_A } });
    const env = await db.siteEnvironment.findFirstOrThrow({ where: { siteId } });
    await db.siteInventory.create({
      data: {
        environmentId: env.id,
        refreshedAt: NOW,
        wpVersion,
        phpVersion: "8.3.1",
        wpCliVersion: "2.12.0",
        plugins: [],
        themes: [],
        warnings: [],
        coreUpdateVersion: offered,
        updatesCheckedAt: NOW,
      },
    });
    return { admin, siteId, environmentId: env.id };
  }

  const commands = () =>
    jobs
      .filter((j) => j.type === "remote.command")
      .map((j) => j.type === "remote.command" && j.command);

  it("updates core, upgrades the database, checks health and re-reads the inventory", async () => {
    const { admin, siteId, environmentId } = await siteOn("6.8.3", "6.9.1");
    answer = async (job) => {
      if (job.type === "remote.command") return ok("Success: WordPress updated successfully.");
      if (job.type === "site.health") return health(true);
      if (job.type === "site.inventory") return inventory("6.9.1", null);
      throw new Error(`unexpected ${job.type}`);
    };
    const res = await as(admin.token).post(PATH(siteId), { version: "6.9.1" }).expect(200);
    expect(res.body).toMatchObject({ status: "updated", fromVersion: "6.8.3", toVersion: "6.9.1" });
    expect(commands()).toEqual([{ op: "core.update", version: "6.9.1" }, { op: "core.update-db" }]);
    const inv = await db.siteInventory.findUniqueOrThrow({ where: { environmentId } });
    expect(inv).toMatchObject({ wpVersion: "6.9.1", coreUpdateVersion: null });
    expect(notices).toEqual([]);
    expect(
      await db.auditLog.findFirstOrThrow({ where: { action: "site.core.update.result" } }),
    ).toMatchObject({ result: "success", siteIds: [siteId] });
  });

  it("re-installs the previous release when the site is unhealthy afterwards", async () => {
    const { admin, siteId } = await siteOn("6.8.3", "6.9.1");
    let healthCalls = 0;
    answer = async (job) => {
      if (job.type === "remote.command") return ok();
      if (job.type === "site.health") return health(++healthCalls > 1);
      if (job.type === "site.inventory") return inventory("6.8.3", "6.9.1");
      throw new Error(`unexpected ${job.type}`);
    };
    const res = await as(admin.token).post(PATH(siteId), { version: "6.9.1" }).expect(200);
    expect(res.body.status).toBe("rolled_back");
    expect(commands()).toEqual([
      { op: "core.update", version: "6.9.1" },
      { op: "core.update-db" },
      { op: "core.update", version: "6.8.3", force: true },
    ]);
    expect(notices).toMatchObject([
      { kind: "deployment.rolled_back", title: "WordPress update rolled back on Core Site" },
    ]);
  });

  it("says so loudly when the rollback doesn't bring the site back", async () => {
    const { admin, siteId } = await siteOn("6.8.3", "6.9.1");
    answer = async (job) => {
      if (job.type === "remote.command") return ok();
      if (job.type === "site.health") return health(false);
      if (job.type === "site.inventory") return inventory("6.8.3", "6.9.1");
      throw new Error(`unexpected ${job.type}`);
    };
    const res = await as(admin.token).post(PATH(siteId), { version: "6.9.1" }).expect(200);
    expect(res.body.status).toBe("rollback_failed");
    expect(notices[0]).toMatchObject({ severity: "critical" });
  });

  it("stops before anything else when WP-CLI can't update", async () => {
    const { admin, siteId } = await siteOn("6.8.3", "6.9.1");
    answer = async (job) => {
      if (job.type === "remote.command")
        return { ...ok(), exitCode: 1, stderr: "Error: core updates are disabled" };
      if (job.type === "site.inventory") return inventory("6.8.3", "6.9.1");
      throw new Error(`unexpected ${job.type}`);
    };
    const res = await as(admin.token).post(PATH(siteId), { version: "6.9.1" }).expect(200);
    expect(res.body.status).toBe("failed");
    expect(commands()).toHaveLength(1);
    expect(jobs.some((j) => j.type === "site.health")).toBe(false);
  });

  it("only installs the release the last check offered, and needs deploy permission", async () => {
    const { admin, siteId } = await siteOn("6.8.3", "6.9.1");
    await as(admin.token).post(PATH(siteId), { version: "7.0" }).expect(409);
    await as(admin.token).post(PATH(siteId), { version: "latest" }).expect(400);
    const viewer = await userWithSession(db, "VIEWER", {
      sessionSecret: SECRET,
      now: NOW,
      email: "viewer@example.test",
    });
    await as(viewer.token).post(PATH(siteId), { version: "6.9.1" }).expect(403);
    expect(jobs).toEqual([]);

    const current = await siteOnSecond(admin.token);
    await as(admin.token).post(PATH(current), { version: "6.9.1" }).expect(409);
  });

  async function siteOnSecond(token: string) {
    const created = await as(token)
      .post("/sites", {
        name: "Current",
        host: "OTHER",
        tags: [],
        production: { ...production, url: "https://current.example.test" },
        staging: null,
      })
      .expect(201);
    const siteId = created.body.id as string;
    await db.siteEnvironment.updateMany({ where: { siteId }, data: { hostKey: KEY_A } });
    const env = await db.siteEnvironment.findFirstOrThrow({ where: { siteId } });
    await db.siteInventory.create({
      data: {
        environmentId: env.id,
        refreshedAt: NOW,
        wpVersion: "6.9.1",
        phpVersion: "8.3.1",
        wpCliVersion: "2.12.0",
        plugins: [],
        themes: [],
        warnings: [],
      },
    });
    return siteId;
  }
});
