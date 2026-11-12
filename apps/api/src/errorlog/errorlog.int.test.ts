// PHP error log viewer (A159) against Postgres with a fake runner: reading now, the overview,
// alerts only for new fatal errors from the last day, the 6-hour schedule and permissions.
import type { ErrorGroup, RunnerJob } from "@ulixops/shared";
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
import { collectDueErrorLogs } from "./service";

const SECRET = "s".repeat(64);
const KEY_A = `SHA256:${"A".repeat(43)}`;
const NOW = new Date(Date.UTC(2026, 10, 1, 12, 0, 0));
const HOUR = 3_600_000;

const group = (over: Partial<ErrorGroup>): ErrorGroup => ({
  level: "warning",
  message: "Undefined variable $x",
  source: "plugin:hello",
  file: "wp-content/plugins/hello.php",
  line: 3,
  count: 1,
  count24h: 1,
  firstAt: new Date(NOW.getTime() - HOUR).toISOString(),
  lastAt: new Date(NOW.getTime() - HOUR).toISOString(),
  trace: [],
  ...over,
});

describe.runIf(TEST_DATABASE_URL)("PHP error log viewer (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  let clock = NOW;
  const now = () => clock;
  let notices: NotifyInput[] = [];
  const notifier = {
    alert: async (_e: SecurityAlertEvent) => undefined,
    notify: async (input: NotifyInput) => {
      notices.push(input);
    },
  };
  let groups: ErrorGroup[] = [];
  let jobs: RunnerJob[] = [];
  let exposed = false;
  let readingDebug: Record<string, boolean | null> = {};
  const before = { WP_DEBUG: false, WP_DEBUG_LOG: null, WP_DEBUG_DISPLAY: null };
  const on = { WP_DEBUG: true, WP_DEBUG_LOG: true, WP_DEBUG_DISPLAY: false };
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      if (job.type === "site.debuglog")
        return {
          hostKeyMismatch: false,
          hostKey: KEY_A,
          ok: !(job.action === "enable" && exposed),
          exposed: job.action === "enable" && exposed,
          method: "mu-plugin",
          previous: before,
          current: job.action === "enable" && !exposed ? on : before,
          pluginInstalled: job.action === "enable" && !exposed,
          detail: exposed ? "Anyone could download it" : "done",
        };
      if (job.type !== "site.errorlog") return {};
      return {
        hostKeyMismatch: false,
        hostKey: KEY_A,
        debug: readingDebug,
        pluginInstalled: Boolean(readingDebug.WP_DEBUG),
        logSource: readingDebug.WP_DEBUG ? "ulixops" : "none",
        fileFound: true,
        sizeBytes: 4096,
        modifiedAt: groups[0]?.lastAt ?? null,
        truncated: false,
        groups,
      };
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
    };
  };
  const user = (role: "SUPER_ADMIN" | "ADMIN" | "DEVELOPER" | "VIEWER", email: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, email });

  async function site(token: string, name: string) {
    const created = await as(token)
      .post("/sites", {
        name,
        host: "OTHER",
        tags: [],
        production: {
          url: `https://${name.toLowerCase()}.example.test`,
          sshHost: `${name.toLowerCase()}.ssh.example.test`,
          sshPort: 22,
          sshUser: "wp",
          wpPath: "/sites/x",
          credentialRef: "X_SSH_KEY",
        },
        staging: null,
      })
      .expect(201);
    const siteId = created.body.id as string;
    await db.siteEnvironment.updateMany({ where: { siteId }, data: { hostKey: KEY_A } });
    return siteId;
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    clock = NOW;
    notices = [];
    jobs = [];
    groups = [];
    exposed = false;
    readingDebug = before;
  });
  afterAll(() => db.$disconnect());

  it("reads a site's log on request and shows it per site and across sites", async () => {
    const a = await user("ADMIN", "a@example.test");
    const shop = await site(a.token, "Shop");
    await site(a.token, "Quiet");
    groups = [
      group({ level: "fatal", message: "Uncaught Error: boom", count: 3, count24h: 3 }),
      group({ count: 5, count24h: 5 }),
    ];
    const read = await as(a.token)
      .post(`/sites/${shop}/environments/production/php-errors`)
      .expect(200);
    expect(read.body).toMatchObject({ ok: true, fatal24h: 3, errors24h: 3, warnings24h: 5 });
    expect(read.body.groups).toHaveLength(2);
    expect(
      (await as(a.token).get(`/sites/${shop}/php-errors`).expect(200)).body.groups,
    ).toHaveLength(2);

    const overview = (await as(a.token).get("/monitoring/php-errors").expect(200)).body;
    expect(overview.rows.map((r: { siteName: string }) => r.siteName)).toEqual(["Shop", "Quiet"]);
    expect(overview.rows[0]).toMatchObject({
      fatal24h: 3,
      top: { message: "Uncaught Error: boom" },
    });
    expect(overview.rows[1]).toMatchObject({ readAt: null, top: null });
    expect(await db.auditLog.count({ where: { action: "site.errorlog.read" } })).toBe(1);
  });

  it("alerts once per new fatal error from the last day, never for old ones", async () => {
    const a = await user("ADMIN", "a@example.test");
    const shop = await site(a.token, "Shop");
    const read = () =>
      as(a.token).post(`/sites/${shop}/environments/production/php-errors`).expect(200);
    // Weeks old (like WSI's): no alert.
    groups = [group({ level: "fatal", count24h: 0, lastAt: "2026-09-17T09:22:05.000Z" })];
    await read();
    expect(notices).toEqual([]);
    // A new one: alerted.
    groups = [group({ level: "fatal", message: "Uncaught Error: new" })];
    await read();
    expect(notices).toMatchObject([{ kind: "php.fatal", severity: "warning" }]);
    expect(notices[0]?.body).toContain("Uncaught Error: new [plugin:hello] ×1");
    // Same error, read again: no second alert.
    await read();
    expect(notices).toHaveLength(1);
  });

  it("reads production sites every 6 hours and keeps the last good reading on failure", async () => {
    const a = await user("ADMIN", "a@example.test");
    await site(a.token, "Shop");
    groups = [group({})];
    expect(await collectDueErrorLogs(deps)).toBe(1);
    expect(await collectDueErrorLogs(deps)).toBe(0);
    clock = new Date(NOW.getTime() + 7 * HOUR);
    const failing: RunnerClient = { run: async () => ({ unexpected: true }) };
    expect(await collectDueErrorLogs({ ...deps, runner: failing })).toBe(1);
    const row = await db.phpErrorLog.findFirstOrThrow();
    expect(row).toMatchObject({
      ok: false,
      detail: "The runner returned an unexpected answer.",
      warnings24h: 1,
    });
    expect(jobs.filter((j) => j.type === "site.errorlog")).toHaveLength(1);
  });

  it("lets Viewers look but not read over SSH", async () => {
    const a = await user("ADMIN", "a@example.test");
    const v = await user("VIEWER", "v@example.test");
    const shop = await site(a.token, "Shop");
    await as(v.token).get("/monitoring/php-errors").expect(200);
    await as(v.token).get(`/sites/${shop}/php-errors`).expect(200);
    await as(v.token).post(`/sites/${shop}/environments/production/php-errors`).expect(403);
    await as(a.token).get(`/sites/${shop}/php-errors?kind=staging`).expect(404);
  });

  it("switches logging on via mu-plugin, trims the private log, and removes the plugin (A167)", async () => {
    const a = await user("ADMIN", "a@example.test");
    const shop = await site(a.token, "Shop");
    const path = `/sites/${shop}/environments/production/debug-log`;
    expect((await as(a.token).post(path, { enabled: true }).expect(200)).body).toMatchObject({
      ok: true,
    });
    expect(jobs.at(-1)).toMatchObject({
      type: "site.debuglog",
      action: "enable",
      siteUrl: "https://shop.example.test",
    });
    const row = await db.phpErrorLog.findFirstOrThrow();
    expect(row).toMatchObject({ managed: true, previousDebug: null, debug: on });
    const view = (await as(a.token).get(`/sites/${shop}/php-errors`).expect(200)).body;
    expect(view.logging).toMatchObject({
      state: "on",
      display: false,
      managed: true,
      viaPlugin: true,
    });
    // Private UlixOps log is trimmed when it grows.
    readingDebug = on;
    await as(a.token).post(`/sites/${shop}/environments/production/php-errors`).expect(200);
    expect(jobs.at(-1)).toMatchObject({ type: "site.errorlog", trim: true });

    await as(a.token).post(path, { enabled: false }).expect(200);
    expect(jobs.at(-1)).toMatchObject({
      type: "site.debuglog",
      action: "disable",
    });
    expect(await db.phpErrorLog.findFirstOrThrow()).toMatchObject({
      managed: false,
      previousDebug: null,
    });
    expect(
      await db.auditLog.count({
        where: { action: { startsWith: "site.debuglog." }, result: "success" },
      }),
    ).toBe(2);
    await as(a.token).post(path, { enabled: false }).expect(409);
  });

  it("reports a downloadable log and stays off; only Admins can switch", async () => {
    const a = await user("ADMIN", "a@example.test");
    const d = await user("DEVELOPER", "d@example.test");
    const shop = await site(a.token, "Shop");
    const path = `/sites/${shop}/environments/production/debug-log`;
    await as(d.token).post(path, { enabled: true }).expect(403);
    exposed = true;
    const r = await as(a.token).post(path, { enabled: true }).expect(200);
    expect(r.body).toMatchObject({ ok: false, exposed: true });
    expect(await db.phpErrorLog.count({ where: { managed: true } })).toBe(0);
    expect(
      await db.auditLog.count({ where: { action: "site.debuglog.enable", result: "failure" } }),
    ).toBe(1);
  });

  it("switches logging on for several sites after another Admin approves", async () => {
    const a = await user("ADMIN", "a@example.test");
    const b = await user("ADMIN", "b@example.test");
    const ids = [await site(a.token, "Shop"), await site(a.token, "Cafe")];
    const envs = await db.siteEnvironment.findMany({ where: { siteId: { in: ids } } });
    const asked = await as(a.token)
      .post("/monitoring/php-errors/logging-bulk", { environmentIds: envs.map((e) => e.id) })
      .expect(202);
    expect(asked.body).toMatchObject({ selfApproved: false, count: 2 });
    expect(jobs.filter((j) => j.type === "site.debuglog")).toEqual([]);
    await as(b.token).post(`/approvals/${asked.body.requestId}/approve`).expect(200);
    for (let i = 0; i < 50 && notices.every((n) => n.kind !== "php.logging"); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(jobs.filter((j) => j.type === "site.debuglog")).toHaveLength(2);
    expect(notices.find((n) => n.kind === "php.logging")?.title).toBe(
      "PHP error logging switched on for 2 of 2 sites",
    );
  });

  it("lets a Super Admin approve a stuck bulk logging request on a second click (A134)", async () => {
    const admin = await user("ADMIN", "a@example.test");
    const boss = await user("SUPER_ADMIN", "boss@example.test");
    const ids = [await site(admin.token, "Shop"), await site(admin.token, "Cafe")];
    const envs = await db.siteEnvironment.findMany({ where: { siteId: { in: ids } } });
    const envIds = envs.map((e) => e.id);
    await as(admin.token)
      .post("/monitoring/php-errors/logging-bulk", { environmentIds: envIds })
      .expect(202);
    expect(jobs.filter((j) => j.type === "site.debuglog")).toEqual([]);
    // Admin re-click still blocked.
    await as(admin.token)
      .post("/monitoring/php-errors/logging-bulk", { environmentIds: envIds })
      .expect(409);
    // Super Admin re-click approves the pending request instead of 409.
    const again = await as(boss.token)
      .post("/monitoring/php-errors/logging-bulk", { environmentIds: envIds })
      .expect(202);
    expect(again.body).toMatchObject({ selfApproved: true, count: 2 });
    for (let i = 0; i < 50 && jobs.filter((j) => j.type === "site.debuglog").length < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(jobs.filter((j) => j.type === "site.debuglog")).toHaveLength(2);
    expect(await db.approvalRequest.count({ where: { status: "PENDING" } })).toBe(0);
  });

  it("stops calling logging its own once the mu-plugin is gone", async () => {
    const a = await user("ADMIN", "a@example.test");
    const shop = await site(a.token, "Shop");
    await as(a.token)
      .post(`/sites/${shop}/environments/production/debug-log`, { enabled: true })
      .expect(200);
    // Next read: plugin no longer present (fake reading reports WP_DEBUG off).
    readingDebug = before;
    await as(a.token).post(`/sites/${shop}/environments/production/php-errors`).expect(200);
    const view = (await as(a.token).get(`/sites/${shop}/php-errors`).expect(200)).body;
    expect(view.logging).toMatchObject({ state: "off", managed: false });
    expect(await db.auditLog.count({ where: { action: "site.debuglog.reverted" } })).toBe(1);
  });
});
