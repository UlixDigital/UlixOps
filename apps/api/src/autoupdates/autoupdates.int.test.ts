// Scheduled updates (A162) against Postgres with a fake runner: switching on needs approval,
// staging first then only staging-tested versions on production, majors only listed, the first
// problem rolls back and stops the run, a rolled-back version is held, busy sites wait.
import type { InventoryItem, RunnerJob } from "@ulixops/shared";
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
import { currentAutoUpdates, startDueAutoUpdates } from "./service";

const SECRET = "s".repeat(64);
const KEY_A = `SHA256:${"A".repeat(43)}`;
const SHA = "a".repeat(64);
// Sunday 2026-11-01 12:00 UTC; the test window opens Sunday 11:00.
const NOW = new Date(Date.UTC(2026, 10, 1, 12, 0, 0));
const PROD = "shop.ssh.example.test";
const STAGE = "staging.shop.ssh.example.test";

type SiteState = { wp: string; core: string | null; plugins: InventoryItem[] };
const plugin = (name: string, version: string, updateVersion: string | null): InventoryItem => ({
  name,
  title: name,
  status: "active",
  version,
  updateVersion,
});
const fresh = (): SiteState => ({
  wp: "6.8.1",
  core: "6.8.3",
  plugins: [
    plugin("akismet", "5.3", "5.3.1"),
    plugin("elementor", "3.25.0", "4.0.0"),
    plugin("woocommerce", "9.1", "9.2"),
  ],
});

describe.runIf(TEST_DATABASE_URL)("scheduled updates (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  let notices: NotifyInput[] = [];
  const notifier = {
    alert: async (_e: SecurityAlertEvent) => undefined,
    notify: async (input: NotifyInput) => {
      notices.push(input);
    },
  };
  let jobs: RunnerJob[] = [];
  let state: Record<string, SiteState> = {};
  /** Host and plugin whose new version breaks the health check. */
  let breaks: { host: string; plugin: string } | null = null;
  const host = (job: RunnerJob) => ("target" in job ? job.target.host : "");
  const healthy = (h: string) =>
    !breaks ||
    breaks.host !== h ||
    state[h]?.plugins.find((p) => p.name === breaks?.plugin)?.updateVersion !== null;
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      const h = host(job);
      const s = state[h] ?? fresh();
      state[h] = s;
      const base = { hostKeyMismatch: false, hostKey: KEY_A };
      switch (job.type) {
        case "site.inventory":
          return {
            ...base,
            wpVersion: s.wp,
            phpVersion: "8.3",
            wpCliVersion: "2.11",
            plugins: s.plugins,
            themes: [],
            maintenance: false,
            safeMode: false,
            warnings: [],
            durationMs: 1,
            updatesChecked: true,
            coreUpdateVersion: s.core,
          };
        case "site.health": {
          const ok = healthy(h);
          return {
            ...base,
            ok,
            urls: [],
            errorLog: { checked: false, ok: true, skipped: true, detail: "", fatalLines: 0 },
            thresholdMs: 3000,
            durationMs: 1,
            summary: ok ? "All pages OK" : "Home page 500",
          };
        }
        case "site.snapshot":
          return {
            ...base,
            ok: true,
            pluginVersion: "x",
            includesDb: false,
            sha256: SHA,
            sizeBytes: 10,
            location: `quick/content/${SHA}.bin`,
            detail: "Snapshot ready",
            durationMs: 1,
          };
        case "site.snapshot.restore": {
          const p = s.plugins.find((i) => i.name === job.plugin);
          if (p && p.updateVersion === null) {
            // Back to the version before; it stays on offer.
            const before = fresh().plugins.find((i) => i.name === job.plugin);
            if (before) Object.assign(p, before);
          }
          return { ...base, ...snapshotOk() };
        }
        case "remote.command": {
          const c = job.command;
          if (c.op === "plugin.update") {
            const p = s.plugins.find((i) => i.name === c.slug);
            if (p?.updateVersion)
              Object.assign(p, { version: p.updateVersion, updateVersion: null });
          }
          if (c.op === "core.update") {
            s.wp = c.version;
            s.core = null;
          }
          return { ...base, exitCode: 0, stdout: "Success", stderr: "", durationMs: 1 };
        }
        default:
          return {};
      }
    },
  };
  const snapshotOk = () => ({
    ok: true,
    pluginVersion: "x",
    includesDb: false,
    sha256: SHA,
    sizeBytes: 10,
    location: `quick/content/${SHA}.bin`,
    detail: "Restored",
    durationMs: 1,
  });
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
  const deps = { db, now, runner, notifier, defaultRetentionDays: 7 };
  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (p: string) => set(request(app).get(p)),
      post: (p: string, body: object = {}) => set(request(app).post(p)).send(body),
      put: (p: string, body: object = {}) => set(request(app).put(p)).send(body),
    };
  };
  const user = (role: "SUPER_ADMIN" | "ADMIN" | "DEVELOPER", email: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, email });
  const env = (sshHost: string, url: string) => ({
    url,
    sshHost,
    sshPort: 22,
    sshUser: "wp",
    wpPath: "/sites/x",
    credentialRef: "X_SSH_KEY",
  });

  async function site(token: string, name: string, withStaging: boolean) {
    const slug = name.toLowerCase();
    const created = await as(token)
      .post("/sites", {
        name,
        host: "OTHER",
        tags: [],
        production: env(
          slug === "shop" ? PROD : `${slug}.ssh.example.test`,
          `https://${slug}.example.test`,
        ),
        staging: withStaging ? env(STAGE, `https://staging.${slug}.example.test`) : null,
      })
      .expect(201);
    const siteId = created.body.id as string;
    await db.siteEnvironment.updateMany({ where: { siteId }, data: { hostKey: KEY_A } });
    return siteId;
  }
  /** Switched on with the window open now (Sunday 11:00 UTC), never run. */
  const scheduled = (siteId: string, skip: object[] = []) =>
    db.autoUpdateSchedule.create({
      data: { siteId, enabled: true, dayOfWeek: 0, hourUtc: 11, skip },
    });
  const commands = (h: string) =>
    jobs.flatMap((j) =>
      j.type === "remote.command" && host(j) === h
        ? [`${j.command.op}${"slug" in j.command ? ` ${j.command.slug}` : ""}`]
        : [],
    );

  beforeEach(async () => {
    await resetData(ownerUrl);
    notices = [];
    jobs = [];
    state = {};
    breaks = null;
  });
  afterAll(() => db.$disconnect());

  it("switches on only after another Admin approves", async () => {
    const a = await user("ADMIN", "a@example.test");
    const b = await user("ADMIN", "b@example.test");
    const d = await user("DEVELOPER", "d@example.test");
    const shop = await site(a.token, "Shop", false);

    await as(d.token)
      .post("/auto-updates/enable", { siteIds: [shop] })
      .expect(403);
    await as(d.token)
      .put(`/sites/${shop}/auto-updates`, { dayOfWeek: 1, hourUtc: 3, skip: [] })
      .expect(403);
    await as(a.token)
      .put(`/sites/${shop}/auto-updates`, {
        dayOfWeek: 3,
        hourUtc: 4,
        skip: [{ asset: "plugin", name: "woocommerce" }],
      })
      .expect(200);
    const asked = await as(a.token)
      .post("/auto-updates/enable", { siteIds: [shop] })
      .expect(202);
    expect(asked.body).toMatchObject({ selfApproved: false, count: 1 });
    let view = (await as(a.token).get(`/sites/${shop}/auto-updates`).expect(200)).body;
    expect(view).toMatchObject({ enabled: false, pendingApprovalId: asked.body.requestId });
    await as(a.token)
      .post("/auto-updates/enable", { siteIds: [shop] })
      .expect(409);

    await as(b.token).post(`/approvals/${asked.body.requestId}/approve`).expect(200);
    view = (await as(a.token).get(`/sites/${shop}/auto-updates`).expect(200)).body;
    expect(view).toMatchObject({
      enabled: true,
      window: { dayOfWeek: 3, hourUtc: 4 },
      skip: [{ asset: "plugin", name: "woocommerce" }],
      pendingApprovalId: null,
      nextWindowAt: "2026-11-04T04:00:00.000Z",
    });
    const overview = (await as(d.token).get("/auto-updates").expect(200)).body;
    expect(overview.rows).toMatchObject([{ siteName: "Shop", enabled: true }]);

    // Switching off: an Admin alone, audited.
    await as(a.token).post(`/sites/${shop}/auto-updates/disable`).expect(200);
    expect(
      (await db.autoUpdateSchedule.findUniqueOrThrow({ where: { siteId: shop } })).enabled,
    ).toBe(false);
    const actions = (await db.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map(
      (r) => r.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "site.autoupdate.settings",
        "approval.request",
        "site.autoupdate.disable",
      ]),
    );
  });

  it("a Super Admin switches several sites on at once (self-approval)", async () => {
    const boss = await user("SUPER_ADMIN", "boss@example.test");
    await user("ADMIN", "other@example.test");
    const ids = [await site(boss.token, "Shop", false), await site(boss.token, "Cafe", false)];
    const asked = await as(boss.token)
      .post("/auto-updates/enable", { siteIds: ids, window: { dayOfWeek: 5, hourUtc: 22 } })
      .expect(202);
    expect(asked.body).toMatchObject({ selfApproved: true, count: 2 });
    const rows = await db.autoUpdateSchedule.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.enabled && r.dayOfWeek === 5 && r.hourUtc === 22)).toBe(true);
    // The first run is the next window, not one that is already open.
    expect(rows.every((r) => r.lastWindowAt !== null)).toBe(true);
  });

  it("updates staging, then production with what staging ran; majors only listed", async () => {
    const a = await user("ADMIN", "a@example.test");
    const shop = await site(a.token, "Shop", true);
    await scheduled(shop, [{ asset: "plugin", name: "woocommerce" }]);

    await startDueAutoUpdates(deps);

    expect(commands(STAGE)).toEqual(["plugin.update akismet", "core.update", "core.update-db"]);
    expect(commands(PROD)).toEqual(["plugin.update akismet", "core.update", "core.update-db"]);
    // Staging finished before production started.
    const firstProd = jobs.findIndex((j) => host(j) === PROD);
    expect(jobs.slice(firstProd).some((j) => host(j) === STAGE)).toBe(false);

    const run = await db.autoUpdateRun.findFirstOrThrow({ where: { siteId: shop } });
    expect(run).toMatchObject({ status: "completed", updated: 4, problems: 0 });
    const view = (await as(a.token).get(`/sites/${shop}/auto-updates`).expect(200)).body;
    expect(view.runs[0].manual).toMatchObject([{ name: "elementor", updateVersion: "4.0.0" }]);
    expect(view.runs[0].environments[1].items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "woocommerce", outcome: "skipped" }),
        expect.objectContaining({ name: "wordpress", outcome: "updated" }),
      ]),
    );
    expect(notices.map((n) => n.kind)).toEqual(["autoupdate.completed"]);
    expect(await db.siteEnvironmentLock.count()).toBe(0);
    expect(
      await db.auditLog.findFirstOrThrow({ where: { action: "site.autoupdate.run" } }),
    ).toMatchObject({ userId: null, result: "success", siteIds: [shop] });

    // Once per window.
    jobs = [];
    await startDueAutoUpdates(deps);
    expect(jobs).toEqual([]);
  });

  it("a broken update on staging is rolled back, held, and production is left alone", async () => {
    const a = await user("ADMIN", "a@example.test");
    const shop = await site(a.token, "Shop", true);
    await scheduled(shop);
    breaks = { host: STAGE, plugin: "akismet" };

    await startDueAutoUpdates(deps);

    expect(jobs.some((j) => j.type === "site.snapshot.restore" && host(j) === STAGE)).toBe(true);
    // Stopped at the first problem: no core update on staging, nothing at all on production.
    expect(commands(STAGE)).toEqual(["plugin.update akismet"]);
    expect(commands(PROD)).toEqual([]);
    const run = await db.autoUpdateRun.findFirstOrThrow({ where: { siteId: shop } });
    expect(run).toMatchObject({ status: "problems", problems: 1 });
    const schedule = await db.autoUpdateSchedule.findUniqueOrThrow({ where: { siteId: shop } });
    expect(schedule.holds).toMatchObject([{ asset: "plugin", name: "akismet", version: "5.3.1" }]);
    expect(notices.map((n) => n.kind)).toEqual(["autoupdate.problems"]);

    // Next week the held version is skipped; the rest goes ahead.
    breaks = null;
    jobs = [];
    await db.autoUpdateSchedule.update({ where: { siteId: shop }, data: { lastWindowAt: null } });
    await startDueAutoUpdates(deps);
    const rest = ["plugin.update woocommerce", "core.update", "core.update-db"];
    expect(commands(STAGE)).toEqual(rest);
    expect(commands(PROD)).toEqual(rest);

    // An Admin clears the hold (audited).
    await as(a.token)
      .post(`/sites/${shop}/auto-updates/holds/clear`, { asset: "plugin", name: "akismet" })
      .expect(200);
    expect(await db.auditLog.count({ where: { action: "site.autoupdate.hold_clear" } })).toBe(1);
  });

  it("doesn't update a site that is unhealthy before it starts", async () => {
    const a = await user("ADMIN", "a@example.test");
    const shop = await site(a.token, "Shop", false);
    await scheduled(shop);
    // Unhealthy from the start: the fake breaks whenever akismet is current, so mark it current.
    state[PROD] = fresh();
    breaks = { host: PROD, plugin: "elementor" };
    const el = state[PROD].plugins.find((p) => p.name === "elementor");
    if (el) el.updateVersion = null;

    await startDueAutoUpdates(deps);
    expect(commands(PROD)).toEqual([]);
    expect(await db.autoUpdateRun.findFirstOrThrow()).toMatchObject({ status: "problems" });
  });

  it("waits for a busy site and tries again inside the window", async () => {
    const a = await user("ADMIN", "a@example.test");
    const shop = await site(a.token, "Shop", false);
    await scheduled(shop);
    const prod = await db.siteEnvironment.findFirstOrThrow({ where: { siteId: shop } });
    await db.siteEnvironmentLock.create({
      data: { environmentId: prod.id, token: "backup", lockedAt: NOW },
    });
    await startDueAutoUpdates(deps);
    expect(jobs).toEqual([]);
    expect(
      (await db.autoUpdateSchedule.findUniqueOrThrow({ where: { siteId: shop } })).lastWindowAt,
    ).toBeNull();

    await db.siteEnvironmentLock.deleteMany();
    await startDueAutoUpdates(deps);
    await currentAutoUpdates();
    expect(commands(PROD)).toEqual([
      "plugin.update akismet",
      "plugin.update woocommerce",
      "core.update",
      "core.update-db",
    ]);
  });

  it("marks a run cut off by a restart as interrupted", async () => {
    const a = await user("ADMIN", "a@example.test");
    const shop = await site(a.token, "Shop", false);
    await db.autoUpdateRun.create({
      data: { siteId: shop, windowAt: NOW, startedAt: NOW, status: "running" },
    });
    await startDueAutoUpdates(deps);
    expect(await db.autoUpdateRun.findFirstOrThrow()).toMatchObject({ status: "interrupted" });
    expect(notices.map((n) => n.kind)).toEqual(["autoupdate.problems"]);
  });
});
