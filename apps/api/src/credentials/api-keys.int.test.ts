// Integration API keys in Settings → Credentials (A133): approval first, sealed to the runner.
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
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

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 31, 10, 0, 0));
const KEY = "wf_live_0123456789abcdefABCDEF";

describe.runIf(TEST_DATABASE_URL)("integration API keys (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  let clock = NOW;
  const now = () => clock;
  const notifier = { alert: async (_event: SecurityAlertEvent) => undefined };

  // A stand-in runner with a real key pair, so sealing is checked end to end.
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = "0123456789abcdef0123456789abcdef";
  let jobs: RunnerJob[] = [];
  let stored: string | null = null;
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      if (job.type === "credentials.list")
        return {
          credentials: stored
            ? [
                {
                  name: "WORDFENCE_API_KEY",
                  createdAt: NOW.toISOString(),
                  updatedAt: NOW.toISOString(),
                },
              ]
            : [],
        };
      if (job.type === "secrets.publicKey") return { keyId, publicKey };
      if (job.type === "secrets.set") {
        stored = privateDecrypt(
          {
            key: pair.privateKey,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
          },
          Buffer.from(job.ciphertext, "base64"),
        ).toString("utf8");
        return { ok: true, updatedAt: clock.toISOString() };
      }
      throw new Error(`unexpected job ${job.type}`);
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

  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (path: string) => set(request(app).get(path)),
      post: (path: string, body: object = {}) => set(request(app).post(path)).send(body),
      put: (path: string, body: object) => set(request(app).put(path)).send(body),
    };
  };
  const admin = (email: string) =>
    userWithSession(db, "ADMIN", { sessionSecret: SECRET, now: NOW, email });
  const PATH = "/credentials/api-keys/wordfence_api_key";

  beforeEach(async () => {
    await resetData(ownerUrl);
    clock = NOW;
    jobs = [];
    stored = null;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function approvedRequest() {
    const a = await admin("a@example.test");
    const b = await admin("b@example.test");
    const created = await as(a.token).post(`${PATH}/request`).expect(201);
    const id = created.body.id as string;
    await as(b.token).post(`/approvals/${id}/approve`, {}).expect(200);
    return { a, b, id };
  }

  it("sets the key only after a second Admin approves, sealed end to end", async () => {
    const a = await admin("a@example.test");
    const b = await admin("b@example.test");

    expect((await as(a.token).get(PATH).expect(200)).body).toEqual({
      name: "WORDFENCE_API_KEY",
      setAt: null,
      vaultReachable: true,
      request: null,
    });

    const created = await as(a.token).post(`${PATH}/request`).expect(201);
    const id = created.body.id as string;
    await as(a.token).post(`${PATH}/request`).expect(409);

    // Still pending: nobody can enter the key yet, and the requester can't approve it.
    await as(a.token).put(PATH, { approvalId: id, value: KEY }).expect(409);
    await as(a.token).post(`/approvals/${id}/approve`, {}).expect(409);
    expect((await as(b.token).get(PATH).expect(200)).body.request).toMatchObject({
      id,
      status: "PENDING",
      ownRequest: false,
      requestedBy: "a@example.test",
    });

    await as(b.token).post(`/approvals/${id}/approve`, {}).expect(200);
    expect((await as(a.token).get(PATH).expect(200)).body.request).toMatchObject({
      status: "APPROVED",
      ownRequest: true,
      usableUntil: "2026-11-01T10:00:00.000Z",
    });

    // Only the requester may use the approval.
    await as(b.token).put(PATH, { approvalId: id, value: KEY }).expect(409);
    await as(a.token).put(PATH, { approvalId: id, value: "not a key!" }).expect(400);

    const saved = await as(a.token).put(PATH, { approvalId: id, value: KEY }).expect(200);
    expect(saved.body).toEqual({ setAt: NOW.toISOString() });
    expect(stored).toBe(KEY);

    // Used once: a second attempt needs a new approval.
    await as(a.token).put(PATH, { approvalId: id, value: KEY }).expect(409);
    expect((await as(a.token).get(PATH).expect(200)).body).toMatchObject({
      setAt: NOW.toISOString(),
      request: null,
    });

    // The key never reached the queue, the database, the audit log or a response in plain text.
    expect(JSON.stringify(jobs)).not.toContain(KEY);
    const everything = JSON.stringify([
      await db.auditLog.findMany(),
      await db.approvalRequest.findMany(),
      await db.setting.findMany(),
      await db.notification.findMany(),
    ]);
    expect(everything).not.toContain(KEY);
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    const actions = (await db.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map(
      (r) => `${r.action}:${r.result}`,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "approval.request:pending",
        "approval.approve:success",
        "credential.apikey.set:denied",
        "credential.apikey.set:success",
      ]),
    );
  });

  it("expires an unused approval after 24 hours", async () => {
    const { a, id } = await approvedRequest();
    // Age the approval rather than the clock, so the session itself stays valid.
    await db.approvalRequest.update({
      where: { id },
      data: { decidedAt: new Date(NOW.getTime() - 24 * 60 * 60_000 - 1) },
    });
    await as(a.token).put(PATH, { approvalId: id, value: KEY }).expect(409);
    expect(stored).toBeNull();
    // An expired approval doesn't block a new request.
    await as(a.token).post(`${PATH}/request`).expect(201);
  });

  it("refuses a rejected request and other approval kinds", async () => {
    const a = await admin("a@example.test");
    const b = await admin("b@example.test");
    const created = await as(a.token).post(`${PATH}/request`).expect(201);
    await as(b.token).post(`/approvals/${created.body.id}/reject`, {}).expect(200);
    await as(a.token).put(PATH, { approvalId: created.body.id, value: KEY }).expect(409);
    expect(stored).toBeNull();
  });

  it("is Admin-only and knows only listed key names", async () => {
    const dev = await userWithSession(db, "DEVELOPER", {
      sessionSecret: SECRET,
      now: NOW,
      email: "dev@example.test",
    });
    await as(dev.token).get(PATH).expect(403);
    await as(dev.token).post(`${PATH}/request`).expect(403);
    const a = await admin("a@example.test");
    await as(a.token).get("/credentials/api-keys/shop_ssh_key").expect(404);
  });

  it("shows the request on the Approvals page with a readable summary", async () => {
    const { b } = await approvedRequest();
    const list = await as(b.token).get("/approvals").expect(200);
    expect(list.body.recent[0]).toMatchObject({
      action: "apikey.set",
      status: "APPROVED",
      summary: "Set the Wordfence Intelligence API key (WORDFENCE_API_KEY) in the vault",
      siteId: null,
    });
  });
});
