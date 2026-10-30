// Deploy wizard: create, approval gate, orchestrate snapshot→deploy→health, pause (real Postgres, stub runner).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerJob } from "@ulixops/shared";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL, userWithSession } from "../../test/db";
import { pluginZip } from "../../test/zip";
import { createApp } from "../app";
import { LoginGuard, MemoryCounter } from "../auth/limits";
import { AuthService } from "../auth/service";
import { createPrisma } from "../db";
import { PluginStore } from "../plugins/store";
import type { RunnerClient } from "../runner/client";
import { SnapshotStore } from "../snapshots/store";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 30, 12, 0, 0));
const KEY_A = `SHA256:${"A".repeat(43)}`;

const production = {
  url: "https://shop.example.test",
  sshHost: "shop.ssh.example.test",
  sshPort: 22,
  sshUser: "shop",
  wpPath: "/sites/shop",
  credentialRef: "SHOP_SSH_KEY",
};

function snapOk() {
  return {
    hostKeyMismatch: false as const,
    ok: true,
    hostKey: KEY_A,
    sha256: "a".repeat(64),
    sizeBytes: 100,
    pluginVersion: "0.9.0",
    includesDb: false,
    location: `quick/content/${"a".repeat(64)}.bin`,
    detail: "Snapshot captured",
    durationMs: 10,
  };
}

function deployOk() {
  return {
    hostKeyMismatch: false as const,
    ok: true,
    hostKey: KEY_A,
    detail: "Deployed ulix-forms",
    durationMs: 20,
  };
}

function healthOk() {
  return {
    hostKeyMismatch: false as const,
    ok: true,
    hostKey: KEY_A,
    urls: [],
    errorLog: {
      checked: true,
      ok: true,
      skipped: true,
      detail: "skipped",
      fatalLines: 0,
    },
    thresholdMs: 5_000,
    durationMs: 30,
    summary: "Healthy",
  };
}

function healthBad() {
  return { ...healthOk(), ok: false, summary: "Unhealthy: homepage critical error" };
}

describe.runIf(TEST_DATABASE_URL)("deployments (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  let pluginDir = "";
  let snapDir = "";
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
    notifier: { alert: async () => {} },
    now,
    sessionSecret: SECRET,
    totpKey: "ab".repeat(32),
    issuer: "UlixOps",
    webauthn: { rpID: "localhost", rpName: "UlixOps", origin: "http://localhost:3000" },
    dummyPasswordHash: "unused",
  });
  let app: ReturnType<typeof createApp>;

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (p: string) => set(request(app).get(p)),
      post: (p: string, body: object = {}) => set(request(app).post(p)).send(body),
      upload: (zip: Buffer) =>
        set(request(app).post(`/plugins/uploads?filename=ulix-forms.zip`))
          .set("content-type", "application/zip")
          .send(zip),
    };
  };
  const make = (role: "ADMIN" | "DEVELOPER" | "VIEWER", email?: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, ...(email ? { email } : {}) });

  async function publish(token: string) {
    const check = await as(token).upload(pluginZip()).expect(200);
    await as(token)
      .post("/plugins/versions", {
        uploadId: check.body.uploadId,
        changelog: "Deploy test",
        dbChanging: false,
      })
      .expect(201);
    return { slug: check.body.slug as string, version: check.body.version as string };
  }

  async function addSite(admin: string, name: string, url: string) {
    const res = await as(admin)
      .post("/sites", {
        name,
        host: "WPENGINE",
        tags: [],
        production: { ...production, url, sshHost: `${name}.ssh.example.test` },
        staging: null,
      })
      .expect(201);
    const id = res.body.id as string;
    await db.siteEnvironment.updateMany({ where: { siteId: id }, data: { hostKey: KEY_A } });
    return id;
  }

  async function waitFor(deploymentId: string, status: string, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await db.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
      if (row.status === status) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    const row = await db.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
    throw new Error(`timed out waiting for ${status}, got ${row.status}`);
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    if (pluginDir) await rm(pluginDir, { recursive: true, force: true });
    if (snapDir) await rm(snapDir, { recursive: true, force: true });
    pluginDir = await mkdtemp(path.join(tmpdir(), "ulixops-deploy-p-"));
    snapDir = await mkdtemp(path.join(tmpdir(), "ulixops-deploy-s-"));
    jobs = [];
    answer = async (job) => {
      if (job.type === "site.snapshot") return snapOk();
      if (job.type === "site.plugin.deploy") return deployOk();
      if (job.type === "site.health") return healthOk();
      if (job.type === "site.snapshot.restore") return snapOk();
      return {};
    };
    app = createApp({
      auth,
      db,
      now,
      runner,
      pluginStore: new PluginStore(pluginDir),
      snapshotStore: new SnapshotStore(snapDir),
      sessionSecret: SECRET,
    });
  });
  afterAll(async () => {
    await db.$disconnect();
    if (pluginDir) await rm(pluginDir, { recursive: true, force: true });
    if (snapDir) await rm(snapDir, { recursive: true, force: true });
  });

  it("deploys a single site without approval: snapshot → deploy → health", async () => {
    const admin = await make("ADMIN");
    const plugin = await publish(admin.token);
    const siteId = await addSite(admin.token, "Shop", "https://shop.example.test");

    const created = await as(admin.token)
      .post("/deployments", {
        pluginSlug: plugin.slug,
        version: plugin.version,
        siteIds: [siteId],
        stagingFirst: false,
        batchSize: 1,
        pauseOnFailure: true,
      })
      .expect(201);
    expect(created.body.approvalId).toBeNull();
    // kickDeployment may already have moved QUEUED → RUNNING before the 201 body is built.
    expect(["QUEUED", "RUNNING"]).toContain(created.body.deployment.status);

    await waitFor(created.body.deployment.id, "SUCCEEDED");
    const view = await as(admin.token)
      .get(`/deployments/${created.body.deployment.id}`)
      .expect(200);
    expect(view.body.deployment.status).toBe("SUCCEEDED");
    expect(view.body.deployment.targets).toHaveLength(1);
    expect(view.body.deployment.targets[0].status).toBe("DONE");
    expect(jobs.map((j) => j.type)).toEqual(["site.snapshot", "site.plugin.deploy", "site.health"]);
  });

  it("queues bulk deploys for approval and starts after a second Admin approves", async () => {
    const requester = await make("DEVELOPER", "dev@example.test");
    const approver = await make("ADMIN", "approver@example.test");
    const plugin = await publish(approver.token);
    const a = await addSite(approver.token, "Alpha", "https://a.example.test");
    const b = await addSite(approver.token, "Beta", "https://b.example.test");

    const created = await as(requester.token)
      .post("/deployments", {
        pluginSlug: plugin.slug,
        version: plugin.version,
        siteIds: [a, b],
        stagingFirst: false,
        batchSize: 2,
      })
      .expect(201);
    expect(created.body.deployment.status).toBe("PENDING_APPROVAL");
    expect(created.body.approvalId).toMatch(/^[a-z0-9]+$/);

    const list = await as(approver.token).get("/approvals").expect(200);
    const pending = list.body.pending.find((r: { id: string }) => r.id === created.body.approvalId);
    expect(pending.summary).toMatch(/Deploy ulix-forms/);

    await as(approver.token)
      .post(`/approvals/${created.body.approvalId}/approve`, { comment: "Go" })
      .expect(200);

    await waitFor(created.body.deployment.id, "SUCCEEDED");
    const row = await db.deployment.findUniqueOrThrow({
      where: { id: created.body.deployment.id },
    });
    expect(row.approvedById).toBe(approver.user.id);
    expect(jobs.filter((j) => j.type === "site.plugin.deploy")).toHaveLength(2);
  });

  it("rolls back and pauses when health fails after deploy", async () => {
    const admin = await make("ADMIN");
    const plugin = await publish(admin.token);
    const siteId = await addSite(admin.token, "Shop", "https://shop.example.test");
    answer = async (job) => {
      if (job.type === "site.snapshot" || job.type === "site.snapshot.restore") return snapOk();
      if (job.type === "site.plugin.deploy") return deployOk();
      if (job.type === "site.health") return healthBad();
      return {};
    };

    const created = await as(admin.token)
      .post("/deployments", {
        pluginSlug: plugin.slug,
        version: plugin.version,
        siteIds: [siteId],
        stagingFirst: false,
        pauseOnFailure: true,
      })
      .expect(201);

    await waitFor(created.body.deployment.id, "PAUSED");
    const view = await as(admin.token)
      .get(`/deployments/${created.body.deployment.id}`)
      .expect(200);
    expect(view.body.deployment.targets[0].status).toBe("ROLLED_BACK");
    expect(jobs.map((j) => j.type)).toEqual([
      "site.snapshot",
      "site.plugin.deploy",
      "site.health",
      "site.snapshot.restore",
    ]);
  });

  it("refuses viewers creating deploys and untested connections", async () => {
    const admin = await make("ADMIN");
    const viewer = await make("VIEWER", "viewer@example.test");
    const plugin = await publish(admin.token);
    const res = await as(admin.token)
      .post("/sites", {
        name: "Shop",
        host: "WPENGINE",
        tags: [],
        production,
        staging: null,
      })
      .expect(201);
    // No host key pinned.
    await as(viewer.token)
      .post("/deployments", {
        pluginSlug: plugin.slug,
        version: plugin.version,
        siteIds: [res.body.id],
      })
      .expect(403);
    await as(admin.token)
      .post("/deployments", {
        pluginSlug: plugin.slug,
        version: plugin.version,
        siteIds: [res.body.id],
      })
      .expect(409)
      .expect({ error: "connection_untested" });
  });
});
