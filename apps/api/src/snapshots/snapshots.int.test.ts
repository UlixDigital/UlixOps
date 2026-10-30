// Quick snapshots: create / list / restore / update / retention (real Postgres, stub runner).
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import type { SecurityAlertEvent } from "../notify";
import { type RunnerClient, RunnerUnavailableError } from "../runner/client";
import { SnapshotStore } from "./store";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 29, 12, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;

const production = {
  url: "https://snap.example.test",
  sshHost: "snap.ssh.example.test",
  sshPort: 22,
  sshUser: "snap",
  wpPath: "/sites/snap",
  credentialRef: "SNAP_SSH_KEY",
};

describe.runIf(TEST_DATABASE_URL)("quick snapshots (Postgres)", () => {
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
  let storeDir = "";
  let store: SnapshotStore;
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
    alerts = [];
    jobs = [];
    storeDir = await mkdtemp(path.join(tmpdir(), "ulixops-snap-"));
    store = new SnapshotStore(storeDir);
    app = createApp({
      auth,
      db,
      now,
      notifier,
      runner,
      sessionSecret: SECRET,
      snapshotStore: store,
      defaultRetentionDays: 7,
    });
    answer = async () => ({});
  });
  afterAll(() => db.$disconnect());

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (path: string) => set(request(app).get(path)),
      post: (path: string, body: object = {}) => set(request(app).post(path)).send(body),
      put: (path: string, body: object = {}) => set(request(app).put(path)).send(body),
    };
  };
  const make = (role: "ADMIN" | "DEVELOPER" | "VIEWER") =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW });

  async function siteWithPin() {
    const admin = await make("ADMIN");
    const created = await as(admin.token).post("/sites", {
      name: "Snap Site",
      host: "OTHER",
      tags: [],
      production,
      staging: null,
    });
    expect(created.status).toBe(201);
    const siteId = created.body.id as string;
    await db.siteEnvironment.updateMany({
      where: { siteId },
      data: { hostKey: KEY_A },
    });
    return { admin, siteId };
  }

  it("creates a quick snapshot via the runner and lists it", async () => {
    const { admin, siteId } = await siteWithPin();
    answer = async (job) => {
      if (job.type !== "site.snapshot") throw new Error(`unexpected ${job.type}`);
      const location = store.locationFor(job.backupId);
      const file = path.join(storeDir, location);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.from("encrypted-bytes"), {
        flag: "wx",
        mode: 0o640,
      });
      return {
        hostKeyMismatch: false,
        ok: true,
        hostKey: KEY_A,
        pluginVersion: "1.2.3",
        includesDb: false,
        sha256: "a".repeat(64),
        sizeBytes: 16,
        location,
        detail: "Snapshot of hello 1.2.3 (16 bytes encrypted)",
        durationMs: 50,
      };
    };
    const res = await as(admin.token).post(`/sites/${siteId}/environments/production/snapshots`, {
      plugin: "hello",
      includeDb: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe("SUCCEEDED");
    expect(res.body.backup).toMatchObject({
      status: "READY",
      pluginName: "hello",
      pluginVersion: "1.2.3",
      sizeBytes: 16,
    });
    expect(jobs[0]).toMatchObject({ type: "site.snapshot", plugin: "hello" });

    const list = await as(admin.token).get(`/sites/${siteId}/environments/production/snapshots`);
    expect(list.status).toBe(200);
    expect(list.body.backups).toHaveLength(1);

    const hub = await as(admin.token).get("/backups");
    expect(hub.status).toBe(200);
    expect(hub.body.backups[0].siteName).toBe("Snap Site");
  });

  it("refuses Viewers creating snapshots and restores via emergency permission", async () => {
    const { admin, siteId } = await siteWithPin();
    const viewer = await make("VIEWER");
    const denied = await as(viewer.token).post(
      `/sites/${siteId}/environments/production/snapshots`,
      { plugin: "hello" },
    );
    expect(denied.status).toBe(403);

    answer = async (job) => {
      if (job.type === "site.snapshot") {
        const file = path.join(storeDir, store.locationFor(job.backupId));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, Buffer.from("x"), { flag: "wx" });
        return {
          hostKeyMismatch: false,
          ok: true,
          hostKey: KEY_A,
          pluginVersion: "1.0",
          includesDb: false,
          sha256: "b".repeat(64),
          sizeBytes: 1,
          location: store.locationFor(job.backupId),
          detail: "ok",
          durationMs: 1,
        };
      }
      return {
        hostKeyMismatch: false,
        ok: true,
        hostKey: KEY_A,
        pluginVersion: "1.0",
        includesDb: false,
        sha256: null,
        sizeBytes: null,
        location: null,
        detail: "restored",
        durationMs: 1,
      };
    };
    const created = await as(admin.token).post(
      `/sites/${siteId}/environments/production/snapshots`,
      { plugin: "hello" },
    );
    const backupId = created.body.backup.id as string;
    const developer = await make("DEVELOPER");
    const restored = await as(developer.token).post(
      `/sites/${siteId}/environments/production/snapshots/${backupId}/restore`,
    );
    expect(restored.status).toBe(200);
    expect(restored.body.job.status).toBe("SUCCEEDED");
  });

  it("marks the backup FAILED when the runner times out", async () => {
    const { admin, siteId } = await siteWithPin();
    answer = async () => {
      throw new RunnerUnavailableError("The runner did not answer in time");
    };
    const res = await as(admin.token).post(`/sites/${siteId}/environments/production/snapshots`, {
      plugin: "hello",
      includeDb: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe("FAILED");
    expect(res.body.backup.status).toBe("FAILED");
    const row = await db.backup.findFirstOrThrow({ where: { siteId } });
    expect(row.status).toBe("FAILED");
  });

  it("updates retention in Settings", async () => {
    const admin = await make("ADMIN");
    const get = await as(admin.token).get("/settings");
    expect(get.status).toBe(200);
    expect(get.body.snapshotRetentionDays).toBe(7);
    const put = await as(admin.token).put("/settings/snapshot-retention", { days: 14 });
    expect(put.status).toBe(200);
    expect(put.body.days).toBe(14);
    const again = await as(admin.token).get("/settings");
    expect(again.body.snapshotRetentionDays).toBe(14);
  });

  it("snapshots before a plugin update", async () => {
    const { admin, siteId } = await siteWithPin();
    const env = await db.siteEnvironment.findFirstOrThrow({ where: { siteId } });
    await db.siteInventory.create({
      data: {
        environmentId: env.id,
        refreshedAt: NOW,
        wpVersion: "6.9",
        phpVersion: "8.3",
        wpCliVersion: "2.12",
        plugins: [
          {
            name: "akismet",
            title: "Akismet",
            status: "active",
            version: "5.3",
            updateVersion: "6.0",
          },
        ],
        themes: [],
        warnings: [],
      },
    });
    let snapCount = 0;
    answer = async (job) => {
      if (job.type === "site.snapshot") {
        snapCount += 1;
        const file = path.join(storeDir, store.locationFor(job.backupId));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, Buffer.from("x"), { flag: "wx" });
        expect(job.includeDb).toBe(true); // major bump 5 → 6
        return {
          hostKeyMismatch: false,
          ok: true,
          hostKey: KEY_A,
          pluginVersion: "5.3",
          includesDb: true,
          sha256: "c".repeat(64),
          sizeBytes: 1,
          location: store.locationFor(job.backupId),
          detail: "snap",
          durationMs: 1,
        };
      }
      if (job.type === "remote.command") {
        expect(job.command).toEqual({ op: "plugin.update", slug: "akismet" });
        return {
          hostKeyMismatch: false,
          exitCode: 0,
          stdout: "Success: Updated 1 of 1 plugins.",
          stderr: "",
          hostKey: KEY_A,
          durationMs: 10,
        };
      }
      if (job.type === "site.inventory") {
        return {
          hostKeyMismatch: false,
          hostKey: KEY_A,
          wpVersion: "6.7",
          phpVersion: "8.2",
          wpCliVersion: "2.11",
          plugins: [
            {
              name: "akismet",
              title: "Akismet",
              status: "active",
              version: "6.0",
              updateVersion: null,
            },
          ],
          themes: [],
          maintenance: false,
          safeMode: false,
          warnings: [],
          durationMs: 5,
        };
      }
      throw new Error(`unexpected ${job.type}`);
    };
    const res = await as(admin.token).post(
      `/sites/${siteId}/environments/production/plugins/update`,
      { plugin: "akismet" },
    );
    expect(res.status).toBe(200);
    expect(snapCount).toBe(1);
    expect(res.body.backup.status).toBe("READY");
    expect(res.body.updateJob.status).toBe("SUCCEEDED");
  });
});
