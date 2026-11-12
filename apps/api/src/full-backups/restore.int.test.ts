// Restore from Google Drive (A152): ask with the site's name → a second Admin approves (or a
// Super Admin self-approves) → one at a time, site locked, safety copy kept 7 days, health check
// afterwards; refusals, rejection, cancel, and that safety copies never touch the weekly copy.
import { DEFAULT_BACKUP_SCHEDULE, type RestoreJobResult, type RunnerJob } from "@ulixops/shared";
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
import { dispatchRestores, pruneSafetyCopies } from "./restore";
import { dispatchFullBackups, writeBackupSchedule, writeDriveRecord } from "./service";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 10, 1, 10, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;
const DAY = 86_400_000;

const health = (ok: boolean) => ({
  hostKeyMismatch: false,
  ok,
  hostKey: KEY_A,
  urls: [],
  errorLog: { checked: false, ok: true, skipped: true, detail: "skipped", fatalLines: 0 },
  thresholdMs: 5000,
  durationMs: 10,
  summary: ok ? "Healthy." : "Unhealthy: homepage HTTP 500",
});
const restoreResult = (over: Partial<RestoreJobResult & { hostKeyMismatch: false }> = {}) => ({
  hostKeyMismatch: false,
  hostKey: KEY_A,
  ok: true,
  safety: {
    driveFileId: "safetyFile789",
    fileName: "shop-production-before-restore-20261101-1000.tar.gz.ulxb",
    sizeBytes: 5_000_000,
    md5: "b".repeat(32),
    webViewLink: "https://drive.google.com/file/d/safetyFile789/view",
  },
  changed: true,
  database: true,
  files: true,
  warnings: [],
  detail: "Restored the database and files from the backup.",
  durationMs: 1000,
  ...over,
});

describe.runIf(TEST_DATABASE_URL)("restore from Google Drive (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  let clock = NOW;
  const now = () => clock;
  let notices: NotifyInput[] = [];
  const notifier = {
    alert: async (_event: SecurityAlertEvent) => undefined,
    notify: async (input: NotifyInput) => {
      notices.push(input);
    },
  };
  let jobs: RunnerJob[] = [];
  let healthy = true;
  let restoreAnswer: () => Promise<unknown> = async () => restoreResult();
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      switch (job.type) {
        case "site.health":
          return health(healthy);
        case "site.backup.restore":
          return restoreAnswer();
        case "drive.delete":
          return { deleted: job.fileIds, failed: [] };
        case "site.backup":
          return {
            hostKeyMismatch: false,
            hostKey: KEY_A,
            ok: true,
            driveFileId: "weeklyFile2",
            fileName: "shop-production-20261108-1800.tar.gz.ulxb",
            sizeBytes: 1000,
            md5: "c".repeat(32),
            webViewLink: null,
            removed: job.oldFileIds,
            removeFailed: [],
            detail: "Backed up.",
            durationMs: 5,
          };
        default:
          return {};
      }
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
    publicUrl: "https://hub.example.test",
  });
  const deps = { db, now, runner, notifier };

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (p: string) => set(request(app).get(p)),
      post: (p: string, body: object = {}) => set(request(app).post(p)).send(body),
    };
  };
  const user = (role: "ADMIN" | "SUPER_ADMIN" | "DEVELOPER", email: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, email });

  /** A site with a pinned host key and a weekly backup on Drive. */
  async function siteWithBackup(token: string, name = "Shop", withStaging = false) {
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
        staging: withStaging
          ? {
              url: `https://${name.toLowerCase()}stg.wpenginepowered.com/`,
              sshHost: `${name.toLowerCase()}stg.ssh.example.test`,
              sshPort: 22,
              sshUser: "wpstg",
              wpPath: "/sites/xstg",
              credentialRef: "X_SSH_KEY",
            }
          : null,
      })
      .expect(201);
    const siteId = created.body.id as string;
    await db.siteEnvironment.updateMany({ where: { siteId }, data: { hostKey: KEY_A } });
    const env = await db.siteEnvironment.findFirstOrThrow({
      where: { siteId, kind: "PRODUCTION" },
    });
    const backup = await db.fullBackup.create({
      data: {
        environmentId: env.id,
        status: "READY",
        queuedAt: new Date(NOW.getTime() - 2 * DAY),
        startedAt: new Date(NOW.getTime() - 2 * DAY),
        finishedAt: new Date(NOW.getTime() - 2 * DAY),
        driveFileId: "weeklyFile1",
        fileName: "shop-production-20261030-1800.tar.gz.ulxb",
        bytes: 123_456n,
      },
    });
    return { siteId, envId: env.id, backupId: backup.id };
  }
  const ask = (token: string, backupId: string, over: object = {}) =>
    as(token).post("/full-backups/restores", {
      backupId,
      scope: "ALL",
      confirmName: "Shop",
      ...over,
    });
  const settled = async (id: string) => {
    for (let i = 0; i < 150; i++) {
      const row = await db.fullRestore.findUniqueOrThrow({ where: { id } });
      // Finished, and the site lock released: the alert and audit row are written by then.
      const locked = await db.siteEnvironmentLock.count({
        where: { environmentId: row.environmentId },
      });
      if (row.status !== "RUNNING" && row.status !== "QUEUED" && locked === 0) return row;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("restore never finished");
  };

  beforeEach(async () => {
    await resetData(ownerUrl);
    clock = NOW;
    notices = [];
    jobs = [];
    healthy = true;
    restoreAnswer = async () => restoreResult();
    await writeBackupSchedule(db, { ...DEFAULT_BACKUP_SCHEDULE, enabled: false }, "test");
    await writeDriveRecord(db, "ulixdevs@gmail.com", NOW, "test");
  });
  afterAll(() => db.$disconnect());

  it("waits for a second Admin, then takes a safety copy, restores and health-checks", async () => {
    const a = await user("ADMIN", "a@example.test");
    const b = await user("ADMIN", "b@example.test");
    const { siteId, envId, backupId } = await siteWithBackup(a.token);
    const asked = await ask(a.token, backupId).expect(202);
    expect(asked.body.selfApproved).toBe(false);
    const restoreId = asked.body.restoreId as string;
    expect(await db.fullRestore.findUniqueOrThrow({ where: { id: restoreId } })).toMatchObject({
      status: "PENDING_APPROVAL",
    });
    // Nothing runs before the approval; the other Admin is asked.
    await dispatchRestores(deps);
    expect(jobs).toEqual([]);
    expect(notices.map((n) => n.kind)).toEqual(["approval.requested"]);

    const pending = await as(b.token).get("/approvals").expect(200);
    const req = pending.body.pending[0];
    expect(req.summary).toMatch(
      /^Shop \(production\): restore everything \(database and files\) from the Google Drive backup of 2026-10-30 10:00 UTC, after a safety copy$/,
    );
    await as(a.token).post(`/approvals/${req.id}/approve`).expect(409); // own request
    await as(b.token).post(`/approvals/${req.id}/approve`).expect(200);

    const done = await settled(restoreId);
    expect(done).toMatchObject({
      status: "SUCCEEDED",
      approvedById: b.user.id,
      healthOk: true,
      progress: 100,
    });
    expect(jobs.map((j) => j.type)).toEqual(["site.backup.restore", "site.health"]);
    expect(jobs[0]).toMatchObject({
      type: "site.backup.restore",
      restoreId,
      driveFileId: "weeklyFile1",
      sourceBackupId: backupId,
      scope: "ALL",
      safetyBackupId: done.safetyBackupId,
      folderKey: envId,
      folderName: "Shop (production)",
      fileStem: "shop-production",
      expectedBytes: 123_456,
    });
    const safety = await db.fullBackup.findUniqueOrThrow({
      where: { id: done.safetyBackupId ?? "" },
    });
    expect(safety).toMatchObject({
      purpose: "SAFETY",
      status: "READY",
      driveFileId: "safetyFile789",
      expiresAt: new Date(NOW.getTime() + 7 * DAY),
    });
    expect(await db.siteEnvironmentLock.count()).toBe(0);
    expect(await db.siteEnvironment.findUniqueOrThrow({ where: { id: envId } })).toMatchObject({
      lastHealthOk: true,
    });
    const actions = (
      await db.auditLog.findMany({
        where: { siteIds: { has: siteId } },
        orderBy: { createdAt: "asc" },
      })
    ).map((r) => `${r.action}:${r.result}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        "site.backup.restore.request:pending",
        "approval.approve:success",
        "site.backup.restore.start:pending",
        "site.backup.restore.result:success",
      ]),
    );
    expect(notices.at(-1)).toMatchObject({ kind: "restore.succeeded", severity: "info" });

    // The overview lists both copies as restorable, and the restore with its safety copy.
    const view = await as(b.token).get("/full-backups/restores").expect(200);
    expect(view.body.sources.map((s: { purpose: string }) => s.purpose)).toEqual([
      "SAFETY",
      "WEEKLY",
    ]);
    expect(view.body.restores[0]).toMatchObject({
      id: restoreId,
      status: "SUCCEEDED",
      requestedBy: "a@example.test",
      approvedBy: "b@example.test",
      safety: { status: "READY" },
      health: { ok: true },
    });
  });

  it("restores the production backup into staging, changing the site address (A157)", async () => {
    const a = await user("ADMIN", "a@example.test");
    const b = await user("ADMIN", "b@example.test");
    const { siteId, backupId } = await siteWithBackup(a.token, "Shop", true);
    const staging = await db.siteEnvironment.findFirstOrThrow({
      where: { siteId, kind: "STAGING" },
    });
    const overview = await as(a.token).get("/full-backups/restores").expect(200);
    expect(overview.body.targets.map((t: { environment: string }) => t.environment)).toEqual([
      "PRODUCTION",
      "STAGING",
    ]);
    const asked = await ask(a.token, backupId, { scope: "DATABASE", target: "STAGING" }).expect(
      202,
    );
    const req = (await as(b.token).get("/approvals").expect(200)).body.pending[0];
    expect(req.summary).toMatch(
      /^Shop \(staging\): restore database only from the production Google Drive backup of .*, changing the site address to this environment's, after a safety copy$/,
    );
    await as(b.token).post(`/approvals/${req.id}/approve`).expect(200);
    await dispatchRestores(deps);
    const row = await settled(asked.body.restoreId);
    expect(row).toMatchObject({ status: "SUCCEEDED", environmentId: staging.id });
    const job = jobs.find((j) => j.type === "site.backup.restore");
    expect(job).toMatchObject({
      target: { host: "shopstg.ssh.example.test", wpPath: "/sites/xstg" },
      rewrite: { from: "shop.example.test", to: "shopstg.wpenginepowered.com" },
    });
    const list = (await as(a.token).get("/full-backups/restores").expect(200)).body.restores;
    expect(list[0]).toMatchObject({ environment: "STAGING", sourceEnvironment: "PRODUCTION" });
  });

  it("restores a backup into its own environment without changing addresses", async () => {
    const a = await user("ADMIN", "a@example.test");
    const b = await user("ADMIN", "b@example.test");
    const { backupId } = await siteWithBackup(a.token, "Shop", true);
    const asked = await ask(a.token, backupId, { target: "PRODUCTION" }).expect(202);
    const req = (await as(b.token).get("/approvals").expect(200)).body.pending[0];
    await as(b.token).post(`/approvals/${req.id}/approve`).expect(200);
    await dispatchRestores(deps);
    await settled(asked.body.restoreId);
    const job = jobs.find((j) => j.type === "site.backup.restore");
    expect(job && "rewrite" in job ? job.rewrite : undefined).toBeUndefined();
    // A site without staging can't be restored into one.
    const { backupId: other } = await siteWithBackup(a.token, "Solo");
    await ask(a.token, other, { target: "STAGING", confirmName: "Solo" }).expect(404);
  });

  it("lets a Super Admin self-approve, audited and announced to the other Admins", async () => {
    const boss = await user("SUPER_ADMIN", "boss@example.test");
    await user("ADMIN", "other@example.test");
    const { backupId } = await siteWithBackup(boss.token);
    const asked = await ask(boss.token, backupId, { scope: "DATABASE" }).expect(202);
    expect(asked.body.selfApproved).toBe(true);
    expect(await settled(asked.body.restoreId)).toMatchObject({ status: "SUCCEEDED" });
    expect(jobs[0]).toMatchObject({ type: "site.backup.restore", scope: "DATABASE" });
    expect(await db.auditLog.count({ where: { action: "approval.self_approve" } })).toBe(1);
    expect(notices.map((n) => n.kind)).toContain("approval.self_approved");
  });

  it("refuses a wrong name, other roles, a missing backup and a second restore", async () => {
    const a = await user("ADMIN", "a@example.test");
    const dev = await user("DEVELOPER", "dev@example.test");
    const { backupId } = await siteWithBackup(a.token);
    expect((await ask(a.token, backupId, { confirmName: "Shopp" }).expect(400)).body.error).toBe(
      "confirm_mismatch",
    );
    await ask(dev.token, backupId).expect(403);
    await ask(a.token, "nosuchbackup").expect(404);
    await ask(a.token, backupId, { scope: "EVERYTHING" }).expect(400);
    await ask(a.token, backupId, { confirmName: " shop " }).expect(202);
    expect((await ask(a.token, backupId).expect(409)).body.error).toBe("restore_pending");
    await db.fullBackup.update({ where: { id: backupId }, data: { status: "REMOVED" } });
    await db.fullRestore.deleteMany();
    expect((await ask(a.token, backupId).expect(409)).body.error).toBe("backup_not_ready");
    await db.fullBackup.update({ where: { id: backupId }, data: { status: "READY" } });
    await db.setting.deleteMany({ where: { key: "backup.drive" } });
    expect((await ask(a.token, backupId).expect(409)).body.error).toBe("drive_not_connected");
    expect(jobs).toEqual([]);
  });

  it("closes the restore when it's rejected or withdrawn", async () => {
    const a = await user("ADMIN", "a@example.test");
    const b = await user("ADMIN", "b@example.test");
    const { backupId } = await siteWithBackup(a.token);
    const first = await ask(a.token, backupId).expect(202);
    const req = (await as(b.token).get("/approvals").expect(200)).body.pending[0];
    await as(b.token).post(`/approvals/${req.id}/reject`, { comment: "Wrong week" }).expect(200);
    expect(
      await db.fullRestore.findUniqueOrThrow({ where: { id: first.body.restoreId } }),
    ).toMatchObject({ status: "REJECTED" });

    const second = await ask(a.token, backupId).expect(202);
    await as(a.token).post(`/full-backups/restores/${second.body.restoreId}/cancel`).expect(200);
    expect(
      await db.fullRestore.findUniqueOrThrow({ where: { id: second.body.restoreId } }),
    ).toMatchObject({ status: "CANCELLED" });
    expect(
      await db.approvalRequest.findFirstOrThrow({
        where: {
          id:
            (await db.fullRestore.findUniqueOrThrow({ where: { id: second.body.restoreId } }))
              .approvalId ?? "",
        },
      }),
    ).toMatchObject({ status: "REJECTED" });
    await as(a.token).post(`/full-backups/restores/${second.body.restoreId}/cancel`).expect(409);
    expect(await db.auditLog.count({ where: { action: "site.backup.restore.cancel" } })).toBe(1);
    expect(jobs).toEqual([]);
  });

  it("waits while a backup runs or another job holds the site", async () => {
    const boss = await user("SUPER_ADMIN", "boss@example.test");
    const { envId, backupId } = await siteWithBackup(boss.token);
    const running = await db.fullBackup.create({
      data: { environmentId: envId, status: "RUNNING", queuedAt: NOW, startedAt: NOW },
    });
    const lock = await db.siteEnvironmentLock.create({
      data: { environmentId: envId, token: "deploy", lockedAt: NOW },
    });
    const asked = await ask(boss.token, backupId).expect(202);
    await dispatchRestores(deps);
    await db.fullBackup.update({ where: { id: running.id }, data: { status: "READY" } });
    await dispatchRestores(deps);
    expect(
      await db.fullRestore.findUniqueOrThrow({ where: { id: asked.body.restoreId } }),
    ).toMatchObject({ status: "QUEUED" });
    expect(jobs).toEqual([]);
    await db.siteEnvironmentLock.delete({ where: { environmentId: lock.environmentId } });
    await dispatchRestores(deps);
    expect(await settled(asked.body.restoreId)).toMatchObject({ status: "SUCCEEDED" });
  });

  it("records a failure, still keeps the safety copy, and checks the site", async () => {
    const boss = await user("SUPER_ADMIN", "boss@example.test");
    const { backupId } = await siteWithBackup(boss.token);
    healthy = false;
    restoreAnswer = async () =>
      restoreResult({
        ok: false,
        database: false,
        files: false,
        detail:
          "The database import failed: ERROR 2006. The site may be partly restored: restore the safety copy to undo.",
      });
    const asked = await ask(boss.token, backupId).expect(202);
    const done = await settled(asked.body.restoreId);
    expect(done).toMatchObject({ status: "FAILED", healthOk: false });
    expect(done.detail).toMatch(/database import failed/);
    expect(
      await db.fullBackup.findUniqueOrThrow({ where: { id: done.safetyBackupId ?? "" } }),
    ).toMatchObject({ status: "READY", purpose: "SAFETY" });
    expect(notices.at(-1)).toMatchObject({ kind: "restore.failed", severity: "critical" });
    expect(
      await db.auditLog.count({
        where: { action: "site.backup.restore.result", result: "failure" },
      }),
    ).toBe(1);
  });

  it("keeps safety copies out of the weekly backups, and deletes them after 7 days", async () => {
    const boss = await user("SUPER_ADMIN", "boss@example.test");
    const { siteId, backupId } = await siteWithBackup(boss.token);
    const asked = await ask(boss.token, backupId).expect(202);
    const done = await settled(asked.body.restoreId);
    const safetyId = done.safetyBackupId ?? "";

    // Weekly overview and history show only the weekly copy.
    const overview = await as(boss.token).get("/full-backups/overview").expect(200);
    expect(overview.body.sites[0].current.id).toBe(backupId);
    const history = await as(boss.token).get(`/full-backups?siteId=${siteId}`).expect(200);
    expect(history.body.backups.map((b: { id: string }) => b.id)).toEqual([backupId]);
    // A safety copy can't be stopped on its own.
    await as(boss.token).post(`/full-backups/${safetyId}/cancel`).expect(404);

    // The next weekly backup replaces only the weekly copy.
    await as(boss.token).post(`/sites/${siteId}/environments/production/full-backup`).expect(202);
    for (let i = 0; i < 100 && !jobs.some((j) => j.type === "site.backup"); i++)
      await new Promise((r) => setTimeout(r, 20));
    await dispatchFullBackups(deps);
    const weekly = jobs.find((j) => j.type === "site.backup");
    expect(weekly).toMatchObject({ oldFileIds: ["weeklyFile1"] });

    // Day 6: kept. Day 8: deleted from Drive and marked removed.
    clock = new Date(NOW.getTime() + 6 * DAY);
    expect(await pruneSafetyCopies(deps)).toBe(0);
    clock = new Date(NOW.getTime() + 8 * DAY);
    expect(await pruneSafetyCopies(deps)).toBe(1);
    expect(jobs.at(-1)).toEqual({ type: "drive.delete", fileIds: ["safetyFile789"] });
    expect(await db.fullBackup.findUniqueOrThrow({ where: { id: safetyId } })).toMatchObject({
      status: "REMOVED",
    });
    expect(await db.auditLog.count({ where: { action: "site.backup.safety_expired" } })).toBe(1);
  });
});
