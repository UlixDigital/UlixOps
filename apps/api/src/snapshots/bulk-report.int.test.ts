// Bulk update report on Plugins & themes: dismiss, and hide 24 h after the run (A136).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import type { SecurityAlertEvent } from "../notify";
import type { RunnerClient } from "../runner/client";
import { SnapshotStore } from "./store";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 31, 14, 0, 0));
const HOUR = 60 * 60_000;

describe.runIf(TEST_DATABASE_URL)("bulk update report (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  const notifier = { alert: async (_event: SecurityAlertEvent) => undefined };
  const runner: RunnerClient = { run: async () => ({}) };
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
    app = createApp({
      auth,
      db,
      now,
      notifier,
      runner,
      sessionSecret: SECRET,
      snapshotStore: new SnapshotStore(await mkdtemp(path.join(tmpdir(), "ulixops-report-"))),
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

  async function siteWithRun(runStatus: string, decidedHoursAgo: number) {
    const admin = await userWithSession(db, "ADMIN", { sessionSecret: SECRET, now: NOW });
    const created = await as(admin.token)
      .post("/sites", {
        name: "Report Site",
        host: "OTHER",
        tags: [],
        production: {
          url: "https://report.example.test",
          sshHost: "report.ssh.example.test",
          sshPort: 22,
          sshUser: "report",
          wpPath: "/sites/report",
          credentialRef: "REPORT_SSH_KEY",
        },
        staging: null,
      })
      .expect(201);
    const siteId = created.body.id as string;
    await db.approvalRequest.create({
      data: {
        action: "site.bulk_update",
        payload: { siteId, kind: "PRODUCTION", strategy: "snapshots", items: [], runStatus },
        requestedById: admin.user.id,
        decidedById: admin.user.id,
        status: "APPROVED",
        createdAt: new Date(NOW.getTime() - decidedHoursAgo * HOUR),
        decidedAt: new Date(NOW.getTime() - decidedHoursAgo * HOUR),
      },
    });
    return { token: admin.token, siteId };
  }

  const status = (token: string, siteId: string) =>
    as(token).get(`/sites/${siteId}/environments/production/bulk-update/status`).expect(200);

  it("shows a finished report until it's dismissed", async () => {
    const { token, siteId } = await siteWithRun("failed", 1);
    expect((await status(token, siteId)).body.runStatus).toBe("failed");
    await as(token)
      .post(`/sites/${siteId}/environments/production/bulk-update/dismiss`)
      .expect(200);
    expect((await status(token, siteId)).body.runStatus).toBeNull();
    expect(
      await db.auditLog.findFirstOrThrow({ where: { action: "site.bulk_update.dismiss" } }),
    ).toMatchObject({ result: "success", siteIds: [siteId] });
  });

  it("hides a finished report 24 hours after the run", async () => {
    const { token, siteId } = await siteWithRun("completed", 25);
    expect((await status(token, siteId)).body.runStatus).toBeNull();
  });

  it("keeps showing a running update and won't dismiss it", async () => {
    const { token, siteId } = await siteWithRun("running", 30);
    expect((await status(token, siteId)).body).toMatchObject({
      runStatus: "running",
      active: true,
    });
    await as(token)
      .post(`/sites/${siteId}/environments/production/bulk-update/dismiss`)
      .expect(404);
  });
});
