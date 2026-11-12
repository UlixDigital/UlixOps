// Uptime monitoring (A149): what is asked of the runner, the down/up state machine, alerts,
// hub-job and hub-network guards, pause/resume, views, retention and permissions (Postgres,
// stub runner: no real site is contacted).
import type { RunnerJob, UptimeJobResult } from "@ulixops/shared";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import type { NotifyInput } from "../notifications/dispatch";
import type { SecurityAlertEvent } from "../notify";
import { RunnerUnavailableError, type RunnerClient } from "../runner/client";
import { durationText, lastUptimeRun, startUptimeCheck } from "./uptime";

const SECRET = "s".repeat(64);
const MIN = 60_000;
let NOW = new Date(Date.UTC(2026, 9, 31, 16, 0, 0));

describe("durationText", () => {
  it("reads naturally", () => {
    expect(durationText(20_000)).toBe("1 min");
    expect(durationText(12 * MIN)).toBe("12 min");
    expect(durationText(125 * MIN)).toBe("2 h 5 min");
    expect(durationText(120 * MIN)).toBe("2 h");
    expect(durationText(28 * 60 * MIN)).toBe("1 d 4 h");
  });
});

describe.runIf(TEST_DATABASE_URL)("uptime monitoring (Postgres)", () => {
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
  /** Answer per site URL; anything not listed is up (HTTP 200, 120 ms). */
  let down: Record<string, { status: number | null; error: string }> = {};
  let failWith: Error | null = null;
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      if (failWith) throw failWith;
      if (job.type !== "monitor.uptime") throw new Error("unexpected job");
      return {
        results: job.probes.map((p) => {
          const d = down[p.url];
          return d
            ? { id: p.id, ok: false, status: d.status, responseMs: 900, error: d.error }
            : { id: p.id, ok: true, status: 200, responseMs: 120, error: null };
        }),
        durationMs: 5,
      } satisfies UptimeJobResult;
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
  const deps = { db, now, runner, notifier };

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (p: string) => set(request(app).get(p)),
      post: (p: string, body: object = {}) => set(request(app).post(p)).send(body),
      put: (p: string, body: object = {}) => set(request(app).put(p)).send(body),
    };
  };
  const user = (role: "ADMIN" | "DEVELOPER" | "VIEWER") =>
    userWithSession(db, role, {
      sessionSecret: SECRET,
      now: NOW,
      email: `${role.toLowerCase()}@example.test`,
    });

  async function site(token: string, name: string, url: string, stagingUrl?: string) {
    const env = (u: string) => ({
      url: u,
      sshHost: `${name.toLowerCase()}.ssh.example.test`,
      sshPort: 22,
      sshUser: "wp",
      wpPath: "/sites/x",
      credentialRef: "X_SSH_KEY",
    });
    const created = await as(token)
      .post("/sites", {
        name,
        host: "OTHER",
        tags: [],
        production: env(url),
        staging: stagingUrl ? env(stagingUrl) : null,
      })
      .expect(201);
    return created.body.id as string;
  }

  /** One scheduled run, then the clock moves on 5 minutes. */
  async function tick() {
    expect(await startUptimeCheck(deps, { userId: null, ip: null })).toEqual({ ok: true });
    await lastUptimeRun();
    NOW = new Date(NOW.getTime() + 5 * MIN);
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    NOW = new Date(Date.UTC(2026, 9, 31, 16, 0, 0));
    notices = [];
    jobs = [];
    down = {};
    failWith = null;
  });
  afterAll(() => db.$disconnect());

  it("probes production of active sites only, in one batched job", async () => {
    const a = await user("ADMIN");
    await site(a.token, "Shop", "https://www.shop.com", "https://shopstg.wpengine.com");
    const old = await site(a.token, "Old", "https://old.com");
    // Archiving waits for a second Admin; the end state is what matters here.
    await db.site.update({ where: { id: old }, data: { archived: true } });
    await site(a.token, "Dev", "http://localhost:8080");
    await tick();
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job?.type).toBe("monitor.uptime");
    if (job?.type !== "monitor.uptime") return;
    expect(job.probes.map((p) => [p.url, p.sshHost]).sort()).toEqual([
      ["http://localhost:8080", "dev.ssh.example.test"],
      ["https://www.shop.com", "shop.ssh.example.test"],
    ]);
    expect(notices).toHaveLength(0);
    // Routine runs aren't audited (288 a day per site).
    expect(await db.auditLog.count({ where: { action: { startsWith: "monitor.uptime" } } })).toBe(
      0,
    );
  });

  it("goes down after two failed checks, alerts once, and alerts again when back up", async () => {
    const a = await user("ADMIN");
    const shop = await site(a.token, "Shop", "https://www.shop.com");
    await site(a.token, "Blog", "https://blog.com");
    await tick(); // 16:00 up

    down = { "https://www.shop.com": { status: 503, error: "HTTP 503" } };
    await tick(); // 16:05 first failure: no alert yet
    expect(notices).toHaveLength(0);
    let view = await as(a.token).get(`/sites/${shop}/uptime`).expect(200);
    expect(view.body.monitor).toMatchObject({ state: "up", error: "HTTP 503", status: 503 });

    await tick(); // 16:10 second failure: down
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "uptime.down",
        severity: "critical",
        siteIds: [shop],
        title: "Site down: Shop",
      }),
    ]);
    expect(notices[0]?.body).toContain("since 16:05 UTC: HTTP 503");
    view = await as(a.token).get(`/sites/${shop}/uptime`).expect(200);
    expect(view.body.monitor).toMatchObject({
      state: "down",
      downSince: "2026-10-31T16:05:00.000Z",
    });

    await tick(); // 16:15 still down: no second alert
    expect(notices).toHaveLength(1);

    down = {};
    await tick(); // 16:20 back up
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ kind: "uptime.up", severity: "info", siteIds: [shop] });
    expect(notices[1]?.body).toContain("after 15 min down");

    view = await as(a.token).get(`/sites/${shop}/uptime`).expect(200);
    expect(view.body.monitor.state).toBe("up");
    expect(view.body.incidents).toEqual([
      expect.objectContaining({
        startedAt: "2026-10-31T16:05:00.000Z",
        endedAt: "2026-10-31T16:20:00.000Z",
        endReason: "recovered",
        error: "HTTP 503",
        failedChecks: 3,
      }),
    ]);
    // 5 checks, 3 failed.
    expect(view.body.monitor.day).toMatchObject({
      checks: 5,
      failed: 3,
      percent: 40,
      avgResponseMs: 120,
    });
    expect(view.body.hours).toHaveLength(24);
    expect(view.body.hours[23]).toMatchObject({ checks: 5, failed: 3 });

    const actions = await db.auditLog.findMany({
      where: { action: { startsWith: "monitor.uptime" } },
      orderBy: { createdAt: "asc" },
    });
    expect(actions.map((r) => [r.action, r.userId])).toEqual([
      ["monitor.uptime.down", null],
      ["monitor.uptime.up", null],
    ]);
  });

  it("a single failed check never opens an incident", async () => {
    const a = await user("ADMIN");
    await site(a.token, "Shop", "https://www.shop.com");
    await site(a.token, "Blog", "https://blog.com");
    down = { "https://www.shop.com": { status: null, error: "Connection refused" } };
    await tick();
    down = {};
    await tick();
    expect(notices).toHaveLength(0);
    expect(await db.uptimeIncident.count()).toBe(0);
  });

  it("records nothing when every site fails at once (the hub's network)", async () => {
    const a = await user("ADMIN");
    for (const n of ["A", "B", "C"]) await site(a.token, `Site${n}`, `https://site${n}.com`);
    down = Object.fromEntries(
      ["A", "B", "C"].map((n) => [`https://site${n}.com`, { status: null, error: "timeout" }]),
    );
    await tick();
    await tick();
    expect(notices).toHaveLength(0);
    expect(await db.uptimeCheck.count()).toBe(0);
    const overview = await as(a.token).get("/monitoring/uptime").expect(200);
    expect(overview.body.status).toMatchObject({ ok: false });
    expect(overview.body.status.error).toMatch(/hub's own network/);
  });

  it("doesn't count failures while a hub job (deploy, update) holds the site", async () => {
    const a = await user("ADMIN");
    const shop = await site(a.token, "Shop", "https://www.shop.com");
    await site(a.token, "Blog", "https://blog.com");
    const env = await db.siteEnvironment.findFirstOrThrow({
      where: { siteId: shop, kind: "PRODUCTION" },
    });
    await db.siteEnvironmentLock.create({
      data: { environmentId: env.id, token: "t", lockedAt: NOW },
    });
    down = { "https://www.shop.com": { status: 503, error: "HTTP 503" } };
    await tick();
    await tick();
    await tick();
    expect(notices).toHaveLength(0);
    expect(await db.uptimeCheck.count({ where: { excluded: true } })).toBe(3);
    const view = await as(a.token).get(`/sites/${shop}/uptime`).expect(200);
    // Excluded checks don't count against uptime either.
    expect(view.body.monitor.day).toMatchObject({ checks: 0, failed: 0, percent: null });
    expect(view.body.monitor.state).toBe("up");
  });

  it("pauses and resumes monitoring (Admin, audited); pausing ends an open incident", async () => {
    const a = await user("ADMIN");
    const d = await user("DEVELOPER");
    const shop = await site(a.token, "Shop", "https://www.shop.com");
    await site(a.token, "Blog", "https://blog.com");
    down = { "https://www.shop.com": { status: 500, error: "HTTP 500" } };
    await tick();
    await tick();
    expect(notices.map((n) => n.kind)).toEqual(["uptime.down"]);

    await as(d.token).put(`/sites/${shop}/uptime`, { enabled: false }).expect(403);
    await as(a.token).put(`/sites/${shop}/uptime`, { enabled: "no" }).expect(400);
    await as(a.token).put(`/sites/${shop}/uptime`, { enabled: false }).expect(200);
    const incident = await db.uptimeIncident.findFirstOrThrow();
    expect(incident).toMatchObject({ endReason: "paused" });
    expect(incident.endedAt).not.toBeNull();

    jobs = [];
    await tick();
    const job = jobs[0];
    if (job?.type !== "monitor.uptime") throw new Error("no uptime job");
    expect(job.probes.map((p) => p.url)).toEqual(["https://blog.com"]);
    expect(notices.map((n) => n.kind)).toEqual(["uptime.down"]); // no "up" for a pause

    const overview = await as(a.token).get("/monitoring/uptime").expect(200);
    expect(overview.body.sites.find((s: { siteId: string }) => s.siteId === shop)).toMatchObject({
      state: "paused",
      enabled: false,
    });
    await as(d.token).post(`/sites/${shop}/uptime-check`).expect(409, { error: "uptime_paused" });

    await as(a.token).put(`/sites/${shop}/uptime`, { enabled: true }).expect(200);
    const audits = await db.auditLog.findMany({ where: { action: "site.uptime.monitoring" } });
    expect(audits.map((r) => r.meta)).toEqual([{ enabled: false }, { enabled: true }]);
  });

  it("archiving a site while it's down ends the incident on the next run", async () => {
    const a = await user("ADMIN");
    const shop = await site(a.token, "Shop", "https://www.shop.com");
    await site(a.token, "Blog", "https://blog.com");
    down = { "https://www.shop.com": { status: 500, error: "HTTP 500" } };
    await tick();
    await tick();
    await db.site.update({ where: { id: shop }, data: { archived: true } });
    await tick();
    expect(await db.uptimeIncident.findFirstOrThrow()).toMatchObject({ endReason: "paused" });
  });

  it("Check now: Developers may, Viewers may not; audited; one run at a time", async () => {
    const a = await user("ADMIN");
    const d = await user("DEVELOPER");
    const v = await user("VIEWER");
    const shop = await site(a.token, "Shop", "https://www.shop.com");
    await as(v.token).post(`/sites/${shop}/uptime-check`).expect(403);
    await as(d.token).post(`/sites/${shop}/uptime-check`).expect(202);
    await lastUptimeRun();
    expect(await db.uptimeCheck.count()).toBe(1);
    const row = await db.auditLog.findFirstOrThrow({ where: { action: "monitor.uptime.check" } });
    expect(row).toMatchObject({ userId: d.user.id, result: "success", siteIds: [shop] });
    await as(d.token).post("/sites/nosuchsite/uptime-check").expect(404);
    // Per-site checks don't touch the schedule's status.
    const overview = await as(v.token).get("/monitoring/uptime").expect(200);
    expect(overview.body.status.lastSuccessAt).toBeNull();
  });

  it("a runner outage records nothing and shows on the status", async () => {
    const a = await user("ADMIN");
    await site(a.token, "Shop", "https://www.shop.com");
    failWith = new RunnerUnavailableError("busy");
    await tick();
    expect(await db.uptimeCheck.count()).toBe(0);
    const overview = await as(a.token).get("/monitoring/uptime").expect(200);
    expect(overview.body.status).toMatchObject({
      ok: false,
      error: "The runner did not answer in time.",
    });
  });

  it("lists uptime on the overview and the sites list; viewers can read it", async () => {
    const a = await user("ADMIN");
    const v = await user("VIEWER");
    const shop = await site(a.token, "Shop", "https://www.shop.com");
    await site(a.token, "Blog", "https://blog.com");
    await tick();
    down = { "https://www.shop.com": { status: 502, error: "HTTP 502" } };
    await tick();
    await tick();

    const overview = await as(v.token).get("/monitoring/uptime").expect(200);
    expect(overview.body.intervalMinutes).toBe(5);
    expect(overview.body.sites.map((s: { siteName: string }) => s.siteName)).toEqual([
      "Blog",
      "Shop",
    ]);
    expect(overview.body.sites[1]).toMatchObject({
      state: "down",
      day: { checks: 3, failed: 2, percent: 33.33 },
    });
    expect(overview.body.incidents).toHaveLength(1);
    expect(overview.body.incidents[0]).toMatchObject({ siteName: "Shop", endedAt: null });

    const list = await as(v.token).get("/sites").expect(200);
    const prod = list.body.sites
      .find((s: { id: string }) => s.id === shop)
      .environments.find((e: { kind: string }) => e.kind === "PRODUCTION");
    expect(prod.uptime).toEqual({
      state: "down",
      since: "2026-10-31T16:05:00.000Z",
      percent24h: 33.33,
      responseMs: null,
    });
  });

  it("drops samples after 30 days and closed incidents after a year", async () => {
    const a = await user("ADMIN");
    const shop = await site(a.token, "Shop", "https://www.shop.com");
    const env = await db.siteEnvironment.findFirstOrThrow({
      where: { siteId: shop, kind: "PRODUCTION" },
    });
    const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * MIN);
    await db.uptimeCheck.createMany({
      data: [
        { environmentId: env.id, checkedAt: ago(31), ok: true },
        { environmentId: env.id, checkedAt: ago(29), ok: true },
      ],
    });
    await db.uptimeIncident.createMany({
      data: [
        { environmentId: env.id, startedAt: ago(400), endedAt: ago(399), endReason: "recovered" },
        { environmentId: env.id, startedAt: ago(200), endedAt: ago(199), endReason: "recovered" },
      ],
    });
    await tick();
    expect(await db.uptimeCheck.count()).toBe(2); // the 29-day-old one and this run's
    expect(await db.uptimeIncident.count()).toBe(1);
  });
});
