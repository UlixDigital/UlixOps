// File integrity checks (A144): results, alerts only on new changes, known-safe rules, partial
// checks, the daily schedule and permissions (Postgres, stub runner).
import {
  DEFAULT_MALWARE_SCHEDULE,
  type IntegrityFinding,
  type IntegrityJobResult,
  type RunnerJob,
} from "@ulixops/shared";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import { writeSchedule } from "../malware/service";
import type { NotifyInput } from "../notifications/dispatch";
import type { SecurityAlertEvent } from "../notify";
import type { RunnerClient } from "../runner/client";
import { dispatchIntegrity, lastIntegrityRun, nextDueIntegrityEnv } from "./service";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 31, 16, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;
const DAY = 24 * 60 * 60_000;

const coreChange: IntegrityFinding = {
  scope: "core",
  component: "wordpress",
  path: "wp-includes/version.php",
  issue: "modified",
};
const pluginChange: IntegrityFinding = {
  scope: "plugin",
  component: "akismet",
  path: "akismet.php",
  issue: "modified",
};

const result = (
  over: Partial<IntegrityJobResult & { hostKeyMismatch: false }> = {},
): IntegrityJobResult => ({
  hostKeyMismatch: false,
  hostKey: KEY_A,
  coreChecked: true,
  pluginsChecked: true,
  verifiedPlugins: 3,
  unverifiable: ["elementor-pro"],
  findings: [],
  detail: "WordPress core matches its checksums. 3 plugins checked, no changes.",
  durationMs: 10,
  ...over,
});

describe.runIf(TEST_DATABASE_URL)("file integrity (Postgres)", () => {
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
  let answer: () => Promise<unknown> = async () => result();
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      return answer();
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
      delete: (p: string) => set(request(app).delete(p)),
    };
  };
  const admin = () => userWithSession(db, "ADMIN", { sessionSecret: SECRET, now: NOW });

  async function site(token: string, name: string, pin = true) {
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
    if (pin) await db.siteEnvironment.updateMany({ where: { siteId }, data: { hostKey: KEY_A } });
    return siteId;
  }
  /** Starts a check through the API and waits for it to finish. */
  async function check(token: string, siteId: string) {
    const res = await as(token).post(`/sites/${siteId}/environments/production/integrity-check`);
    expect(res.status).toBe(202);
    await lastIntegrityRun();
    return db.integrityCheck.findUniqueOrThrow({ where: { id: res.body.checkId } });
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    notices = [];
    jobs = [];
    answer = async () => result();
    await writeSchedule(db, DEFAULT_MALWARE_SCHEDULE, "test");
  });
  afterAll(() => db.$disconnect());

  it("records changes, alerts once, and lists premium plugins as not verifiable", async () => {
    const a = await admin();
    const siteId = await site(a.token, "Shop");
    answer = async () => result({ findings: [coreChange, pluginChange] });
    const first = await check(a.token, siteId);
    expect(first).toMatchObject({ status: "CHANGED", unverifiable: ["elementor-pro"] });
    expect(jobs[0]).toMatchObject({ type: "site.integrity", target: { hostKey: KEY_A } });
    expect(notices).toMatchObject([{ kind: "integrity.changed", severity: "critical" }]);

    // Same changes again: no new alert. A new change: one alert, for that file only.
    notices = [];
    await check(a.token, siteId);
    expect(notices).toEqual([]);
    answer = async () =>
      result({
        findings: [coreChange, pluginChange, { ...pluginChange, path: "x.php", issue: "added" }],
      });
    await check(a.token, siteId);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("akismet › x.php: added");
    expect(notices[0]?.body).not.toContain("version.php");

    const detail = await as(a.token).get(`/integrity-checks/${first.id}`).expect(200);
    expect(detail.body.check).toMatchObject({
      status: "CHANGED",
      findingCount: 2,
      requestedBy: "admin@example.test",
      verifiedPlugins: 3,
    });
    const audits = (await db.auditLog.findMany()).map((r) => `${r.action}:${r.result}`);
    expect(audits).toEqual(
      expect.arrayContaining(["site.integrity.start:pending", "site.integrity.result:changed"]),
    );
  });

  it("marks a deliberate change as safe for later checks, and can undo it", async () => {
    const a = await admin();
    const siteId = await site(a.token, "Shop");
    answer = async () => result({ findings: [pluginChange] });
    const first = await check(a.token, siteId);
    const detail = await as(a.token).get(`/integrity-checks/${first.id}`).expect(200);
    await as(a.token)
      .post(`/integrity-checks/findings/${detail.body.check.findings[0].id}/safe`, {
        reason: "Patched by our developer",
      })
      .expect(200);
    expect((await db.integrityCheck.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      "CLEAN",
    );
    const second = await check(a.token, siteId);
    expect(second.status).toBe("CLEAN");
    expect(second.detail).toContain("1 known-safe change was ignored");
    const rules = await as(a.token).get(`/integrity-checks/${second.id}`).expect(200);
    await as(a.token).delete(`/integrity-checks/ignores/${rules.body.ignores[0].id}`).expect(200);
    expect((await db.integrityCheck.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
      "CHANGED",
    );
  });

  it("keeps core results when the plugin check can't run, and fails when nothing ran", async () => {
    const a = await admin();
    const siteId = await site(a.token, "Shop");
    answer = async () =>
      result({
        pluginsChecked: false,
        unverifiable: [],
        findings: [coreChange],
        detail: "Plugins couldn't be checked.",
      });
    expect(await check(a.token, siteId)).toMatchObject({
      status: "CHANGED",
      pluginsChecked: false,
    });
    answer = async () =>
      result({
        coreChecked: false,
        pluginsChecked: false,
        detail: "WordPress core couldn't be checked.",
      });
    expect(await check(a.token, siteId)).toMatchObject({
      status: "FAILED",
      detail: "WordPress core couldn't be checked.",
    });
  });

  it("runs one daily check at a time inside the window, skipping switched-off sites", async () => {
    const a = await admin();
    const one = await site(a.token, "Alpha");
    const off = await site(a.token, "Off");
    await db.siteEnvironment.updateMany({
      where: { siteId: off },
      data: { malwareAutoScan: false },
    });
    expect((await nextDueIntegrityEnv(db, NOW))?.siteId).toBe(one);
    await dispatchIntegrity(deps);
    await lastIntegrityRun();
    expect(await db.integrityCheck.count()).toBe(1);
    // Checked today: nothing due until tomorrow.
    expect(await nextDueIntegrityEnv(db, NOW)).toBeNull();
    expect((await nextDueIntegrityEnv(db, new Date(NOW.getTime() + DAY)))?.siteId).toBe(one);

    await writeSchedule(db, { ...DEFAULT_MALWARE_SCHEDULE, integrityEnabled: false }, "test");
    await db.integrityCheck.deleteMany({});
    await dispatchIntegrity(deps);
    expect(await db.integrityCheck.count()).toBe(0);

    const overview = await as(a.token).get("/integrity-checks/overview").expect(200);
    expect(overview.body.automatic).toBe(false);
    expect(overview.body.stats.neverChecked).toBe(2);
  });

  it("needs a tested connection and sites.refresh; one check per site at a time", async () => {
    const a = await admin();
    const viewer = await userWithSession(db, "VIEWER", {
      sessionSecret: SECRET,
      now: NOW,
      email: "viewer@example.test",
    });
    const untested = await site(a.token, "Untested", false);
    const tested = await site(a.token, "Tested");
    await as(a.token)
      .post(`/sites/${untested}/environments/production/integrity-check`)
      .expect(409);
    await as(viewer.token)
      .post(`/sites/${tested}/environments/production/integrity-check`)
      .expect(403);
    await as(viewer.token).get("/integrity-checks/overview").expect(200);
    let release: () => void = () => undefined;
    answer = () => new Promise((r) => (release = () => r(result())));
    await as(a.token).post(`/sites/${tested}/environments/production/integrity-check`).expect(202);
    await as(a.token).post(`/sites/${tested}/environments/production/integrity-check`).expect(409);
    release();
    await lastIntegrityRun();
    await as(viewer.token)
      .post("/integrity-checks/findings/abc/safe", { reason: "nope" })
      .expect(403);
    const list = await as(viewer.token).get(`/sites/${tested}/integrity-checks`).expect(200);
    expect(list.body.checks[0]).toMatchObject({ status: "CLEAN", unverifiable: ["elementor-pro"] });
  });
});
