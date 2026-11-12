// Full backups (A145): Drive sign-in, health check first, one copy per site, failures keep the
// old copy, stop, weekly window, never alongside a malware scan, permissions (Postgres, stub runner).
import { DEFAULT_BACKUP_SCHEDULE, type FullBackupJobResult, type RunnerJob } from "@ulixops/shared";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import { dispatchMalwareScans } from "../malware/service";
import type { NotifyInput } from "../notifications/dispatch";
import type { SecurityAlertEvent } from "../notify";
import type { RunnerClient, RunOptions } from "../runner/client";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import {
  dispatchFullBackups,
  nextDueBackupEnv,
  writeBackupSchedule,
  writeDriveRecord,
} from "./service";

const SECRET = "s".repeat(64);
// Friday 2026-10-30 19:00 UTC: inside the default window (Friday 18:00, 8 hours).
const NOW = new Date(Date.UTC(2026, 9, 30, 19, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;

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
const backupResult = (over: Partial<FullBackupJobResult & { hostKeyMismatch: false }> = {}) => ({
  hostKeyMismatch: false,
  hostKey: KEY_A,
  ok: true,
  driveFileId: "newFileId123",
  fileName: "shop-production-20261030-1900.tar.gz.ulxb",
  sizeBytes: 123_456_789,
  md5: "a".repeat(32),
  webViewLink: "https://drive.google.com/file/d/newFileId123/view",
  removed: [] as string[],
  removeFailed: [] as string[],
  detail: "Backed up the database and all files (123 MB encrypted) to Google Drive.",
  durationMs: 1000,
  ...over,
});

describe.runIf(TEST_DATABASE_URL)("full backups (Postgres)", () => {
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
  let healthy = true;
  let backupAnswer: (job: RunnerJob, options: RunOptions) => Promise<unknown> = async (job) =>
    backupResult(job.type === "site.backup" ? { removed: job.oldFileIds } : {});
  let pollStatus: "pending" | "connected" = "pending";
  const finishedCodes: string[] = [];
  const sealPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const runner: RunnerClient = {
    run: async (job, _timeout, options = {}) => {
      jobs.push(job);
      switch (job.type) {
        case "site.health":
          return health(healthy);
        case "site.backup":
          return backupAnswer(job, options);
        case "site.backup.cancel":
          return { running: true };
        case "drive.status":
          return {
            setup: { clientId: true, clientSecret: true, key: true },
            connected: pollStatus === "connected",
            email: "ulixdevs@gmail.com",
            limit: 214748364800,
            usage: 1000,
            error: null,
          };
        case "drive.auth.start":
          return {
            authUrl: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(job.redirectUri)}`,
            state: "a".repeat(32),
          };
        case "secrets.publicKey":
          return { keyId: "b".repeat(32), publicKey: sealPair.publicKey };
        case "drive.auth.finish": {
          const code = privateDecrypt(
            {
              key: sealPair.privateKey,
              padding: constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: "sha256",
            },
            Buffer.from(job.ciphertext, "base64"),
          ).toString();
          finishedCodes.push(code);
          pollStatus = code === "4/good-code" ? "connected" : "pending";
          return code === "4/good-code"
            ? { status: "connected", email: "ulixdevs@gmail.com", detail: "Connected." }
            : { status: "failed", email: null, detail: "Google sign-in failed (invalid_grant)." };
        }
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
      put: (p: string, body: object = {}) => set(request(app).put(p)).send(body),
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
  const backupNow = (token: string, siteId: string) =>
    as(token).post(`/sites/${siteId}/environments/production/full-backup`);
  const settled = async (id: string) => {
    for (let i = 0; i < 150; i++) {
      const row = await db.fullBackup.findUniqueOrThrow({ where: { id } });
      if (row.status !== "RUNNING" && row.status !== "QUEUED") return row;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("backup never finished");
  };
  const connect = () => writeDriveRecord(db, "ulixdevs@gmail.com", NOW, "test");

  beforeEach(async () => {
    await resetData(ownerUrl);
    notices = [];
    jobs = [];
    healthy = true;
    pollStatus = "pending";
    backupAnswer = async (job) =>
      backupResult(job.type === "site.backup" ? { removed: job.oldFileIds } : {});
    await writeBackupSchedule(db, { ...DEFAULT_BACKUP_SCHEDULE, enabled: false }, "test");
  });
  afterAll(() => db.$disconnect());

  it("connects Google Drive with Sign in with Google, sealing the code", async () => {
    const a = await admin();
    const siteId = await site(a.token, "Shop");
    await backupNow(a.token, siteId).expect(409);
    const start = await as(a.token).post("/full-backups/drive/authorize").expect(200);
    expect(start.body.authUrl).toContain(
      encodeURIComponent("https://hub.example.test/oauth/google/callback"),
    );
    const state = "a".repeat(32);
    const bad = await as(a.token)
      .post("/full-backups/drive/authorize/finish", { state, code: "4/bad-code-123" })
      .expect(200);
    expect(bad.body.status).toBe("failed");
    const good = await as(a.token)
      .post("/full-backups/drive/authorize/finish", { state, code: "4/good-code" })
      .expect(200);
    expect(good.body).toMatchObject({ status: "connected", email: "ulixdevs@gmail.com" });
    // The code reached the runner only inside the sealed job.
    expect(finishedCodes).toEqual(["4/bad-code-123", "4/good-code"]);
    expect(JSON.stringify(jobs)).not.toContain("4/good-code");
    await as(a.token)
      .post("/full-backups/drive/authorize/finish", { state: "nope", code: "4/good-code" })
      .expect(400);
    const overview = await as(a.token).get("/full-backups/overview").expect(200);
    expect(overview.body.drive).toMatchObject({
      connected: true,
      email: "ulixdevs@gmail.com",
      redirectUri: "https://hub.example.test/oauth/google/callback",
    });
    expect(
      await db.auditLog.count({ where: { action: "backup.drive.connect", result: "success" } }),
    ).toBe(1);
    await backupNow(a.token, siteId).expect(202);
  });

  it("checks health, backs up, and keeps only the newest copy", async () => {
    await connect();
    const a = await admin();
    const siteId = await site(a.token, "Shop");
    const first = await backupNow(a.token, siteId).expect(202);
    expect(await settled(first.body.backupId)).toMatchObject({
      status: "READY",
      driveFileId: "newFileId123",
    });
    expect(jobs.map((j) => j.type)).toEqual(["site.health", "site.backup"]);

    backupAnswer = async (job) =>
      backupResult({
        driveFileId: "secondFile456",
        removed: job.type === "site.backup" ? job.oldFileIds : [],
      });
    const second = await backupNow(a.token, siteId).expect(202);
    expect(await settled(second.body.backupId)).toMatchObject({
      status: "READY",
      driveFileId: "secondFile456",
    });
    const backupJob = jobs.filter((j) => j.type === "site.backup").at(-1);
    expect(backupJob).toMatchObject({
      oldFileIds: ["newFileId123"],
      expectedBytes: 123_456_789,
      folderName: "Shop (production)",
      fileStem: "shop-production",
    });
    expect(
      await db.fullBackup.findUniqueOrThrow({ where: { id: first.body.backupId } }),
    ).toMatchObject({
      status: "REMOVED",
    });
    const overview = await as(a.token).get("/full-backups/overview").expect(200);
    expect(overview.body.sites[0].health).toMatchObject({ ok: true, summary: "Healthy." });
    expect(overview.body.sites[0].current).toMatchObject({
      id: second.body.backupId,
      bytes: 123_456_789,
    });
    expect(overview.body.stats).toMatchObject({
      protected: 1,
      problems: 0,
      totalBytes: 123_456_789,
    });
    expect(notices).toEqual([]);

    // Site overview "Last backup": the current copy of this site only.
    const latest = await as(a.token)
      .get(`/full-backups?siteId=${siteId}&status=READY&limit=1`)
      .expect(200);
    expect(latest.body.backups.map((b: { id: string }) => b.id)).toEqual([second.body.backupId]);
    const otherSite = await site(a.token, "Blog");
    const none = await as(a.token).get(`/full-backups?siteId=${otherSite}`).expect(200);
    expect(none.body.backups).toEqual([]);
    await as(a.token).get("/full-backups?siteId=Bad!").expect(400);
  });

  it("skips an unhealthy site and keeps last week's copy", async () => {
    await connect();
    const a = await admin();
    const siteId = await site(a.token, "Shop");
    await settled((await backupNow(a.token, siteId).expect(202)).body.backupId);
    healthy = false;
    jobs = [];
    const res = await backupNow(a.token, siteId).expect(202);
    const row = await settled(res.body.backupId);
    expect(row.status).toBe("SKIPPED");
    expect(row.detail).toContain("failed its health check");
    expect(jobs.map((j) => j.type)).toEqual(["site.health"]);
    expect(await db.fullBackup.count({ where: { status: "READY" } })).toBe(1);
    for (let i = 0; i < 50 && notices.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(notices).toMatchObject([{ kind: "backup.skipped", severity: "critical" }]);
    // A147: the backup's check is recorded, so the page can set the site aside.
    const overview = await as(a.token).get("/full-backups/overview").expect(200);
    expect(overview.body.sites[0].health).toMatchObject({
      ok: false,
      summary: "Unhealthy: homepage HTTP 500",
    });
  });

  it("keeps the old copy when the backup fails, and alerts", async () => {
    await connect();
    const a = await admin();
    const siteId = await site(a.token, "Shop");
    await settled((await backupNow(a.token, siteId).expect(202)).body.backupId);
    backupAnswer = async () =>
      backupResult({
        ok: false,
        driveFileId: null,
        detail: "Archiving the site failed (tar exit 2).",
      });
    const res = await backupNow(a.token, siteId).expect(202);
    expect((await settled(res.body.backupId)).status).toBe("FAILED");
    expect(await db.fullBackup.count({ where: { status: "READY" } })).toBe(1);
    // The alert follows the status update.
    for (let i = 0; i < 50 && notices.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(notices).toMatchObject([{ kind: "backup.failed" }]);
  });

  it("shows progress and stops a running backup", async () => {
    await connect();
    const a = await admin();
    const siteId = await site(a.token, "Shop");
    let finish: (v: unknown) => void = () => undefined;
    let report: (d: unknown) => void = () => undefined;
    backupAnswer = (_job, options) =>
      new Promise((resolve) => {
        finish = resolve;
        report = options.onProgress ?? (() => undefined);
      });
    const res = await backupNow(a.token, siteId).expect(202);
    for (let i = 0; i < 100 && !jobs.some((j) => j.type === "site.backup"); i++)
      await new Promise((r) => setTimeout(r, 20));
    report({ phase: "uploading", percent: 40, bytes: 50_000_000 });
    for (let i = 0; i < 100; i++) {
      if (
        (await db.fullBackup.findUniqueOrThrow({ where: { id: res.body.backupId } })).progress ===
        40
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const overview = await as(a.token).get("/full-backups/overview").expect(200);
    expect(overview.body.running).toMatchObject({
      phase: "uploading",
      progress: 40,
      bytes: 50_000_000,
    });
    await as(a.token).post(`/full-backups/${res.body.backupId}/cancel`).expect(200);
    expect(jobs).toContainEqual({ type: "site.backup.cancel", backupId: res.body.backupId });
    finish(backupResult());
    await new Promise((r) => setTimeout(r, 100));
    expect(
      await db.fullBackup.findUniqueOrThrow({ where: { id: res.body.backupId } }),
    ).toMatchObject({
      status: "CANCELLED",
      cancelledById: a.user.id,
    });
  });

  it("backs up each covered site once per weekly window, never alongside a malware scan", async () => {
    await connect();
    const a = await admin();
    const one = await site(a.token, "Alpha");
    const off = await site(a.token, "Off");
    await as(a.token)
      .put(`/sites/${off}/environments/production/backup-auto`, { enabled: false })
      .expect(200);
    await writeBackupSchedule(db, DEFAULT_BACKUP_SCHEDULE, "test");
    expect((await nextDueBackupEnv(db, NOW, DEFAULT_BACKUP_SCHEDULE))?.siteId).toBe(one);
    // Thursday: outside the window.
    expect(
      await nextDueBackupEnv(db, new Date(Date.UTC(2026, 9, 29, 19)), DEFAULT_BACKUP_SCHEDULE),
    ).toBeNull();
    // Saturday 01:00: still inside a window that started Friday 18:00.
    expect(
      (await nextDueBackupEnv(db, new Date(Date.UTC(2026, 9, 31, 1)), DEFAULT_BACKUP_SCHEDULE))
        ?.siteId,
    ).toBe(one);

    // A malware scan running holds the slot: no backup starts.
    const env = await db.siteEnvironment.findFirstOrThrow({ where: { siteId: one } });
    const scan = await db.malwareScan.create({
      data: { environmentId: env.id, status: "RUNNING", startedAt: NOW },
    });
    await dispatchFullBackups(deps);
    expect(await db.fullBackup.count()).toBe(0);
    await db.malwareScan.delete({ where: { id: scan.id } });

    await dispatchFullBackups(deps);
    const auto = await db.fullBackup.findFirstOrThrow({});
    expect(auto.requestedById).toBeNull();
    await settled(auto.id);
    // Done for this window: nothing more due (Off is switched off).
    expect(await nextDueBackupEnv(db, NOW, DEFAULT_BACKUP_SCHEDULE)).toBeNull();

    // And a running backup keeps malware scans from starting.
    await db.fullBackup.create({
      data: { environmentId: env.id, status: "RUNNING", queuedAt: NOW, startedAt: NOW },
    });
    await db.malwareScan.create({
      data: { environmentId: env.id, status: "QUEUED", startedAt: NOW },
    });
    await dispatchMalwareScans(deps);
    expect(await db.malwareScan.count({ where: { status: "RUNNING" } })).toBe(0);
  });

  it("checks permissions and validates the schedule", async () => {
    await connect();
    const a = await admin();
    const viewer = await userWithSession(db, "VIEWER", {
      sessionSecret: SECRET,
      now: NOW,
      email: "v@example.test",
    });
    const dev = await userWithSession(db, "DEVELOPER", {
      sessionSecret: SECRET,
      now: NOW,
      email: "d@example.test",
    });
    const siteId = await site(a.token, "Shop");
    const untested = await site(a.token, "Untested", false);
    await backupNow(viewer.token, siteId).expect(403);
    await backupNow(a.token, untested).expect(409);
    await as(dev.token).post("/full-backups/drive/authorize").expect(403);
    await as(dev.token).put("/full-backups/schedule", DEFAULT_BACKUP_SCHEDULE).expect(403);
    await as(a.token)
      .put("/full-backups/schedule", { ...DEFAULT_BACKUP_SCHEDULE, dayOfWeek: 9 })
      .expect(400);
    await as(a.token)
      .put("/full-backups/schedule", { ...DEFAULT_BACKUP_SCHEDULE, dayOfWeek: 2 })
      .expect(200);
    await as(viewer.token).get("/full-backups/overview").expect(200);
    await as(viewer.token).get("/full-backups?status=READY").expect(200);
    const res = await backupNow(dev.token, siteId).expect(202);
    await settled(res.body.backupId);
  });
});
