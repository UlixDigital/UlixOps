// On-demand health checks and Settings → health-check (real Postgres, stub runner).
import type { HealthJobResult, RunnerJob } from "@ulixops/shared";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import type { SecurityAlertEvent } from "../notify";
import { type RunnerClient, RunnerUnavailableError } from "../runner/client";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 29, 12, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;

const production = {
  url: "https://shop.example.test",
  sshHost: "shop.ssh.example.test",
  sshPort: 22,
  sshUser: "shop",
  wpPath: "/sites/shop",
  credentialRef: "SHOP_SSH_KEY",
};

function healthyResult(overrides: Partial<HealthJobResult & { hostKeyMismatch: false }> = {}) {
  return {
    hostKeyMismatch: false as const,
    ok: true,
    hostKey: KEY_A,
    urls: [
      {
        url: "https://shop.example.test/",
        role: "home" as const,
        ok: true,
        status: 200,
        durationMs: 80,
        detail: "OK",
        criticalText: false,
      },
      {
        url: "https://shop.example.test/wp-admin/",
        role: "wp-admin" as const,
        ok: true,
        status: 200,
        durationMs: 90,
        detail: "wp-admin login page loads",
        criticalText: false,
      },
    ],
    errorLog: {
      checked: true,
      ok: true,
      skipped: true,
      detail: "No wp-content/debug.log (skipped)",
      fatalLines: 0,
    },
    thresholdMs: 5_000,
    durationMs: 200,
    summary: "Healthy. 2/2 URLs ok; error log: No wp-content/debug.log (skipped)",
    ...overrides,
  };
}

describe.runIf(TEST_DATABASE_URL)("site health checks (Postgres)", () => {
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
      put: (path: string, body: object) => set(request(app).put(path)).send(body),
      post: (path: string, body: object = {}) => set(request(app).post(path)).send(body),
    };
  };
  const make = (role: "ADMIN" | "DEVELOPER" | "VIEWER") =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW });

  async function testedSite(admin: string, opts: { pin?: boolean } = {}) {
    const res = await as(admin)
      .post("/sites", { name: "Shop", host: "WPENGINE", tags: [], production, staging: null })
      .expect(201);
    const id = res.body.id as string;
    if (opts.pin !== false)
      await db.siteEnvironment.updateMany({ where: { siteId: id }, data: { hostKey: KEY_A } });
    return id;
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    alerts = [];
    jobs = [];
    answer = async () => ({});
  });
  afterAll(() => db.$disconnect());

  it("lets an Admin save health-check settings and returns them on GET /settings", async () => {
    const admin = await make("ADMIN");
    const viewer = await make("VIEWER");
    await as(viewer.token)
      .put("/settings/health-check", {
        extraPaths: ["/shop/"],
        thresholdMs: 3_000,
        checkErrorLog: false,
      })
      .expect(403);

    const saved = await as(admin.token)
      .put("/settings/health-check", {
        extraPaths: ["/shop/", "/contact/"],
        thresholdMs: 3_000,
        checkErrorLog: false,
      })
      .expect(200);
    expect(saved.body).toEqual({
      extraPaths: ["/shop/", "/contact/"],
      thresholdMs: 3_000,
      checkErrorLog: false,
      checkWpAdmin: false,
    });

    const view = await as(admin.token).get("/settings").expect(200);
    expect(view.body.healthCheck).toEqual(saved.body);

    const audit = await db.auditLog.findFirst({
      where: { action: "settings.health_check" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.result).toBe("success");
  });

  it("runs a health check through the runner and stores the result on the environment", async () => {
    const admin = await make("ADMIN");
    const dev = await make("DEVELOPER");
    const viewer = await make("VIEWER");
    const id = await testedSite(admin.token);
    answer = async () => healthyResult();

    await as(viewer.token).post(`/sites/${id}/environments/production/health`).expect(403);

    const res = await as(dev.token).post(`/sites/${id}/environments/production/health`).expect(200);
    expect(res.body).toMatchObject({
      hostKeyMismatch: false,
      health: {
        ok: true,
        summary: expect.stringContaining("Healthy"),
        urlFailures: 0,
      },
      job: { action: "health.check", status: "SUCCEEDED", exitCode: 0 },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "site.health",
      // Homepage only by default; wp-admin is opt-in (A151).
      urls: ["https://shop.example.test/"],
      origin: "https://shop.example.test",
      thresholdMs: 5_000,
      checkErrorLog: true,
    });

    const site = await as(dev.token).get(`/sites/${id}`).expect(200);
    const env = site.body.environments.find((e: { kind: string }) => e.kind === "PRODUCTION");
    expect(env).toMatchObject({
      lastHealthOk: true,
      lastHealthSummary: expect.stringContaining("Healthy"),
    });
    expect(env.lastHealthAt).toBeTruthy();
  });

  it("marks the job SUCCEEDED when the site is unhealthy (health.ok is false)", async () => {
    const admin = await make("ADMIN");
    const id = await testedSite(admin.token);
    answer = async () =>
      healthyResult({
        ok: false,
        summary: "Unhealthy. 1/2 URLs ok; error log: clean",
        urls: [
          {
            url: "https://shop.example.test/",
            role: "home",
            ok: false,
            status: 500,
            durationMs: 40,
            detail: "Expected HTTP 200, got 500",
            criticalText: false,
          },
          {
            url: "https://shop.example.test/wp-admin/",
            role: "wp-admin",
            ok: true,
            status: 200,
            durationMs: 50,
            detail: "wp-admin login page loads",
            criticalText: false,
          },
        ],
        errorLog: {
          checked: true,
          ok: true,
          skipped: false,
          detail: "No recent fatal/parse lines in debug.log",
          fatalLines: 0,
        },
      });

    const res = await as(admin.token)
      .post(`/sites/${id}/environments/production/health`)
      .expect(200);
    expect(res.body.job.status).toBe("SUCCEEDED");
    expect(res.body.job.exitCode).toBe(1);
    expect(res.body.health).toMatchObject({ ok: false, urlFailures: 1 });

    const env = await db.siteEnvironment.findFirst({ where: { siteId: id } });
    expect(env?.lastHealthOk).toBe(false);
  });

  it("refuses when the host key is not pinned, and includes configured extra paths", async () => {
    const admin = await make("ADMIN");
    const id = await testedSite(admin.token, { pin: false });
    await as(admin.token).post(`/sites/${id}/environments/production/health`).expect(409);

    await db.siteEnvironment.updateMany({ where: { siteId: id }, data: { hostKey: KEY_A } });
    await as(admin.token)
      .put("/settings/health-check", {
        extraPaths: ["/shop/"],
        thresholdMs: 4_000,
        checkErrorLog: false,
        checkWpAdmin: true,
      })
      .expect(200);
    answer = async () => healthyResult({ thresholdMs: 4_000 });
    await as(admin.token).post(`/sites/${id}/environments/production/health`).expect(200);
    expect(jobs[0]).toMatchObject({
      type: "site.health",
      urls: [
        "https://shop.example.test/",
        "https://shop.example.test/wp-admin/",
        "https://shop.example.test/shop/",
      ],
      thresholdMs: 4_000,
      checkErrorLog: false,
    });
  });

  it("fails the job when the runner does not answer", async () => {
    const admin = await make("ADMIN");
    const id = await testedSite(admin.token);
    answer = async () => {
      throw new RunnerUnavailableError();
    };
    const res = await as(admin.token)
      .post(`/sites/${id}/environments/production/health`)
      .expect(200);
    expect(res.body).toMatchObject({
      hostKeyMismatch: false,
      health: null,
      job: { status: "FAILED" },
    });
  });
});
