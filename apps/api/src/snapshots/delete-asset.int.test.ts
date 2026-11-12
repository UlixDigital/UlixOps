// Delete an inactive plugin or theme (A137): snapshot first, then delete, then re-read.
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
import type { RunnerClient } from "../runner/client";
import { SnapshotStore } from "./store";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 31, 15, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;

const item = (name: string, status: string, version = "1.0") => ({
  name,
  title: name,
  status,
  version,
  updateVersion: null,
});

describe.runIf(TEST_DATABASE_URL)("delete plugin / theme (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  const notifier = { alert: async (_event: SecurityAlertEvent) => undefined };
  let jobs: RunnerJob[] = [];
  let answer: (job: RunnerJob) => Promise<unknown> = async () => ({});
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      return answer(job);
    },
  };
  let store: SnapshotStore;
  let storeDir = "";
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
    jobs = [];
    storeDir = await mkdtemp(path.join(tmpdir(), "ulixops-del-"));
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
  });
  afterAll(() => db.$disconnect());

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return { post: (p: string, body: object = {}) => set(request(app).post(p)).send(body) };
  };

  async function site() {
    const admin = await userWithSession(db, "ADMIN", { sessionSecret: SECRET, now: NOW });
    const created = await as(admin.token)
      .post("/sites", {
        name: "Del Site",
        host: "OTHER",
        tags: [],
        production: {
          url: "https://del.example.test",
          sshHost: "del.ssh.example.test",
          sshPort: 22,
          sshUser: "del",
          wpPath: "/sites/del",
          credentialRef: "DEL_SSH_KEY",
        },
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
        wpVersion: "6.9",
        phpVersion: "8.3",
        wpCliVersion: "2.12",
        warnings: [],
        plugins: [item("hello", "inactive", "1.7.2"), item("akismet", "active")],
        themes: [
          item("child", "active"),
          item("parent-theme", "parent"),
          item("twentytwentythree", "inactive", "1.6"),
        ],
      },
    });
    return { token: admin.token, siteId };
  }

  const snapshotOk = async (job: Extract<RunnerJob, { type: "site.snapshot" }>) => {
    const file = path.join(storeDir, store.locationFor(job.backupId));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from("x"), { flag: "wx" });
    return {
      hostKeyMismatch: false,
      ok: true,
      hostKey: KEY_A,
      pluginVersion: "1.0",
      includesDb: false,
      sha256: "d".repeat(64),
      sizeBytes: 1,
      location: store.locationFor(job.backupId),
      detail: "snap",
      durationMs: 1,
    };
  };
  const inventoryAfter = {
    hostKeyMismatch: false,
    hostKey: KEY_A,
    wpVersion: "6.9",
    phpVersion: "8.3",
    wpCliVersion: "2.12",
    plugins: [item("akismet", "active")],
    themes: [item("child", "active"), item("parent-theme", "parent")],
    maintenance: false,
    safeMode: false,
    warnings: [],
    durationMs: 1,
    updatesChecked: true,
    coreUpdateVersion: null,
  };
  const answerAll = (deleteExit = 0) => {
    answer = async (job) => {
      if (job.type === "site.snapshot") return snapshotOk(job);
      if (job.type === "remote.command")
        return {
          hostKeyMismatch: false,
          exitCode: deleteExit,
          stdout: deleteExit === 0 ? "Success: Deleted 1 of 1 plugins." : "",
          stderr: deleteExit === 0 ? "" : "Error: could not delete",
          hostKey: KEY_A,
          durationMs: 2,
        };
      if (job.type === "site.inventory") return inventoryAfter;
      throw new Error(`unexpected ${job.type}`);
    };
  };

  it("snapshots an inactive plugin, deletes it, and re-reads the inventory", async () => {
    const { token, siteId } = await site();
    answerAll();
    const res = await as(token)
      .post(`/sites/${siteId}/environments/production/plugins/delete`, { plugin: "hello" })
      .expect(200);
    expect(res.body.backup.status).toBe("READY");
    expect(res.body.updateJob).toMatchObject({
      status: "SUCCEEDED",
      summary: "Delete plugin hello",
    });
    expect(jobs.map((j) => j.type)).toEqual(["site.snapshot", "remote.command", "site.inventory"]);
    const del = jobs[1];
    if (del?.type === "remote.command")
      expect(del.command).toEqual({ op: "plugin.delete", slug: "hello" });
    const snap = jobs[0];
    if (snap?.type === "site.snapshot")
      expect(snap).toMatchObject({ plugin: "hello", includeDb: false });
  });

  it("deletes an inactive theme but never the active or parent theme", async () => {
    const { token, siteId } = await site();
    answerAll();
    const url = `/sites/${siteId}/environments/production/themes/delete`;
    await as(token).post(url, { theme: "child" }).expect(409);
    await as(token).post(url, { theme: "parent-theme" }).expect(409);
    await as(token)
      .post(`/sites/${siteId}/environments/production/plugins/delete`, {
        plugin: "akismet",
      })
      .expect(409);
    expect(jobs).toEqual([]);
    await as(token).post(url, { theme: "twentytwentythree" }).expect(200);
    const del = jobs.find((j) => j.type === "remote.command");
    if (del?.type === "remote.command")
      expect(del.command).toEqual({ op: "theme.delete", slug: "twentytwentythree" });
  });

  it("doesn't delete anything when the snapshot fails", async () => {
    const { token, siteId } = await site();
    answer = async (job) => {
      if (job.type === "site.snapshot")
        return {
          hostKeyMismatch: false,
          ok: false,
          hostKey: KEY_A,
          pluginVersion: null,
          includesDb: false,
          sha256: null,
          sizeBytes: null,
          location: null,
          detail: "SFTP failed",
          durationMs: 1,
        };
      throw new Error(`unexpected ${job.type}`);
    };
    const res = await as(token)
      .post(`/sites/${siteId}/environments/production/plugins/delete`, { plugin: "hello" })
      .expect(200);
    expect(res.body.updateJob).toBeNull();
    expect(jobs.some((j) => j.type === "remote.command")).toBe(false);
  });

  it("refuses unknown names, odd names and Viewers", async () => {
    const { siteId } = await site();
    const viewer = await userWithSession(db, "VIEWER", {
      sessionSecret: SECRET,
      now: NOW,
      email: "viewer@example.test",
    });
    const admin = await userWithSession(db, "ADMIN", {
      sessionSecret: SECRET,
      now: NOW,
      email: "admin2@example.test",
    });
    const url = `/sites/${siteId}/environments/production/plugins/delete`;
    await as(viewer.token).post(url, { plugin: "hello" }).expect(403);
    await as(admin.token).post(url, { plugin: "nope" }).expect(404);
    await as(admin.token).post(url, { plugin: "--all" }).expect(400);
    expect(jobs).toEqual([]);
  });
});
