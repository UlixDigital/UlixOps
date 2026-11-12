// SSL + domain expiry (A148): what is asked of the runner, storage, alert thresholds, renewals,
// manual domain dates, the daily schedule and permissions (Postgres, stub runner).
import type { ExpiryJobResult, RunnerJob } from "@ulixops/shared";
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
import { expiryRunDue, lastExpiryRun, planChecks, startExpiryCheck } from "./expiry";

const SECRET = "s".repeat(64);
const DAY = 24 * 60 * 60_000;
let NOW = new Date(Date.UTC(2026, 9, 31, 16, 0, 0));
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY).toISOString();

type Answer = ExpiryJobResult["results"][number];
const cert = (host: string, days: number, over: Partial<NonNullable<Answer["ssl"]>> = {}) => ({
  ok: true,
  validFrom: inDays(-30),
  validTo: inDays(days),
  issuer: "Let's Encrypt · R11",
  subject: host,
  altNames: [host],
  error: null,
  ...over,
});
const domain = (
  name: string,
  days: number | null,
  over: Partial<NonNullable<Answer["domain"]>> = {},
) => ({
  domain: name,
  status: days === null ? ("unsupported" as const) : ("found" as const),
  expiresAt: days === null ? null : inDays(days),
  registrar: "Example Registrar",
  error: days === null ? "The registry doesn't publish an expiry date for this domain." : null,
  ...over,
});

describe("planChecks", () => {
  it("checks https certificates, production domains only, and skips dev hosts", () => {
    expect(
      planChecks([
        { kind: "PRODUCTION", url: "https://www.shop.com" },
        { kind: "STAGING", url: "https://shopstg.wpenginepowered.com" },
        { kind: "PRODUCTION", url: "https://client.wpengine.com" },
        { kind: "PRODUCTION", url: "http://plain.com" },
        { kind: "PRODUCTION", url: "http://localhost:8080" },
        { kind: "STAGING", url: "http://test-wp-staging" },
      ]),
    ).toEqual([
      { host: "www.shop.com", port: 443, ssl: true, domain: true },
      { host: "shopstg.wpenginepowered.com", port: 443, ssl: true, domain: false },
      { host: "client.wpengine.com", port: 443, ssl: true, domain: false },
      { host: "plain.com", port: 443, ssl: false, domain: true },
    ]);
  });

  it("runs daily, and 6 h after a failure", () => {
    const at = new Date(NOW);
    const ago = (h: number) => new Date(at.getTime() - h * 3_600_000).toISOString();
    expect(
      expiryRunDue({ lastAttemptAt: null, lastSuccessAt: null, ok: null, error: null }, at),
    ).toBe(true);
    expect(
      expiryRunDue({ lastAttemptAt: ago(2), lastSuccessAt: ago(2), ok: true, error: null }, at),
    ).toBe(false);
    expect(
      expiryRunDue({ lastAttemptAt: ago(25), lastSuccessAt: ago(25), ok: true, error: null }, at),
    ).toBe(true);
    expect(
      expiryRunDue({ lastAttemptAt: ago(3), lastSuccessAt: ago(30), ok: false, error: "x" }, at),
    ).toBe(false);
    expect(
      expiryRunDue({ lastAttemptAt: ago(7), lastSuccessAt: ago(30), ok: false, error: "x" }, at),
    ).toBe(true);
  });
});

describe.runIf(TEST_DATABASE_URL)("SSL and domain expiry (Postgres)", () => {
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
  let answers: Record<string, Omit<Answer, "host">> = {};
  let failWith: Error | null = null;
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      if (failWith) throw failWith;
      if (job.type !== "monitor.expiry") throw new Error("unexpected job");
      return {
        results: job.checks.map((c) => ({
          host: c.host,
          ssl: c.ssl ? (answers[c.host]?.ssl ?? null) : null,
          domain: c.domain ? (answers[c.host]?.domain ?? null) : null,
        })),
        durationMs: 5,
      } satisfies ExpiryJobResult;
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
      put: (p: string, body: object = {}) => set(request(app).put(p)).send(body),
    };
  };
  const user = (role: "ADMIN" | "DEVELOPER" | "VIEWER") =>
    userWithSession(db, role, {
      sessionSecret: SECRET,
      now: NOW,
      email: `${role.toLowerCase()}@example.test`,
    });

  async function site(token: string, name: string, url: string, stagingUrl?: string) {
    const env = (u: string) => ({
      url: u,
      sshHost: `${name.toLowerCase()}.ssh.example.test`,
      sshPort: 22,
      sshUser: "wp",
      wpPath: "/sites/x",
      credentialRef: "X_SSH_KEY",
    });
    const created = await as(token)
      .post("/sites", {
        name,
        host: "OTHER",
        tags: [],
        production: env(url),
        staging: stagingUrl ? env(stagingUrl) : null,
      })
      .expect(201);
    return created.body.id as string;
  }

  async function runAll() {
    expect(startExpiryCheck(deps, { userId: null, ip: null })).toEqual({ ok: true });
    await lastExpiryRun();
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    NOW = new Date(Date.UTC(2026, 9, 31, 16, 0, 0));
    notices = [];
    jobs = [];
    answers = {};
    failWith = null;
  });
  afterAll(() => db.$disconnect());

  it("stores certificates and domains, and lists them for the site and the overview", async () => {
    const a = await user("ADMIN");
    const shop = await site(
      a.token,
      "Shop",
      "https://www.shop.com",
      "https://shopstg.wpengine.com",
    );
    await site(a.token, "Dev", "http://localhost:8080");
    answers = {
      "www.shop.com": { ssl: cert("www.shop.com", 60), domain: domain("shop.com", 400) },
      "shopstg.wpengine.com": { ssl: cert("shopstg.wpengine.com", 80), domain: null },
    };
    await runAll();
    expect(jobs).toHaveLength(1);
    expect(notices).toHaveLength(0);

    const view = await as(a.token).get(`/sites/${shop}/expiry`).expect(200);
    expect(view.body.certificates).toHaveLength(2);
    expect(view.body.certificates[0]).toMatchObject({
      environment: "PRODUCTION",
      host: "www.shop.com",
      ok: true,
      daysLeft: 60,
      domain: "shop.com",
    });
    expect(view.body.certificates[1]).toMatchObject({ environment: "STAGING", domain: null });
    expect(view.body.domains).toEqual([
      expect.objectContaining({
        domain: "shop.com",
        status: "found",
        daysLeft: 400,
        manual: false,
        sites: [{ id: shop, name: "Shop" }],
      }),
    ]);
    expect(view.body.status).toMatchObject({ ok: true, running: false });

    const overview = await as(a.token).get("/monitoring/expiry").expect(200);
    expect(overview.body.certificates).toHaveLength(2);
    expect(overview.body.unchecked).toEqual([
      expect.objectContaining({ siteName: "Dev", url: "http://localhost:8080" }),
    ]);
    const rows = await db.auditLog.findMany({ where: { action: "monitor.expiry.check" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "success", userId: null });
  });

  it("alerts once per threshold, then again after a renewal reaches 30 days", async () => {
    const a = await user("ADMIN");
    const shop = await site(a.token, "Shop", "https://shop.com");
    const validTo = inDays(20);
    answers = {
      "shop.com": { ssl: cert("shop.com", 20, { validTo }), domain: domain("shop.com", 300) },
    };
    await runAll();
    expect(notices.map((n) => [n.kind, n.severity])).toEqual([["ssl.expiring", "warning"]]);
    expect(notices[0]?.title).toBe("SSL certificate expires in 20 days: Shop");
    expect(notices[0]?.siteIds).toEqual([shop]);

    // Next day: same threshold, no repeat.
    NOW = new Date(NOW.getTime() + DAY);
    await runAll();
    expect(notices).toHaveLength(1);

    // 6 days left: crosses 7, critical.
    NOW = new Date(Date.parse(validTo) - 6 * DAY - 3_600_000);
    await runAll();
    expect(notices.map((n) => n.severity)).toEqual(["warning", "critical"]);

    // Renewed for 90 days: quiet, and the alert state resets.
    answers["shop.com"] = { ssl: cert("shop.com", 90), domain: domain("shop.com", 300) };
    await runAll();
    expect(notices).toHaveLength(2);
    const row = await db.sslCertificate.findFirstOrThrow();
    expect(row).toMatchObject({ alertedDays: null, alertedValidTo: null });
  });

  it("alerts on untrusted certificates at once, unreachable only twice in a row", async () => {
    const a = await user("ADMIN");
    await site(a.token, "Shop", "https://shop.com");
    await site(a.token, "Blog", "https://blog.net");
    answers = {
      "shop.com": {
        ssl: cert("shop.com", 60, { ok: false, error: "The certificate is self-signed." }),
        domain: null,
      },
      "blog.net": {
        ssl: {
          ok: false,
          validFrom: null,
          validTo: null,
          issuer: null,
          subject: null,
          altNames: [],
          error: "Couldn't connect over HTTPS: timed out",
        },
        domain: null,
      },
    };
    await runAll();
    expect(notices.map((n) => n.title)).toEqual(["SSL problem on Shop"]);
    await runAll();
    expect(notices.map((n) => n.title)).toEqual(["SSL problem on Shop", "SSL problem on Blog"]);
    await runAll();
    expect(notices).toHaveLength(2);
    // Fixed, then broken again: alerts again.
    answers["shop.com"] = { ssl: cert("shop.com", 60), domain: null };
    await runAll();
    answers["shop.com"] = {
      ssl: cert("shop.com", 60, { ok: false, error: "Wrong name." }),
      domain: null,
    };
    await runAll();
    expect(notices.filter((n) => n.title === "SSL problem on Shop")).toHaveLength(2);
  });

  it("alerts on domain expiry, keeps the last date when a lookup fails, and accepts a manual date", async () => {
    const a = await user("ADMIN");
    const shop = await site(a.token, "Shop", "https://shop.com");
    const de = await site(a.token, "Berlin", "https://www.berlin.de");
    answers = {
      "shop.com": { ssl: cert("shop.com", 60), domain: domain("shop.com", 10) },
      "www.berlin.de": { ssl: cert("www.berlin.de", 60), domain: domain("berlin.de", null) },
    };
    await runAll();
    expect(notices.map((n) => [n.kind, n.title, n.siteIds])).toEqual([
      ["domain.expiring", "Domain shop.com expires in 10 days", [shop]],
    ]);

    answers["shop.com"] = {
      ssl: cert("shop.com", 60),
      domain: {
        domain: "shop.com",
        status: "error",
        expiresAt: null,
        registrar: null,
        error: "The registry answered HTTP 503.",
      },
    };
    await runAll();
    const shopRow = await db.domainRegistration.findUniqueOrThrow({
      where: { domain: "shop.com" },
    });
    expect(shopRow).toMatchObject({ status: "found", error: "The registry answered HTTP 503." });
    expect(shopRow.expiresAt?.toISOString()).toBe(inDays(10));

    // berlin.de has no public expiry: an Admin enters it; a Developer may not.
    const d = await user("DEVELOPER");
    await as(d.token)
      .put("/monitoring/domains/berlin.de/expiry", { expiresAt: "2026-11-05" })
      .expect(403);
    await as(a.token)
      .put("/monitoring/domains/bad name/expiry", { expiresAt: "2026-11-05" })
      .expect(400);
    await as(a.token)
      .put("/monitoring/domains/nope.com/expiry", { expiresAt: "2026-11-05" })
      .expect(404);
    await as(a.token)
      .put("/monitoring/domains/berlin.de/expiry", { expiresAt: "2026-11-05" })
      .expect(200);
    expect(notices.at(-1)).toMatchObject({
      kind: "domain.expiring",
      title: "Domain berlin.de expires in 5 days",
      severity: "critical",
      siteIds: [de],
    });
    const view = await as(a.token).get(`/sites/${de}/expiry`).expect(200);
    expect(view.body.domains[0]).toMatchObject({
      domain: "berlin.de",
      manual: true,
      status: "unsupported",
    });
    const audits = await db.auditLog.findMany({
      where: { action: "monitor.domain.manual_expiry" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: a.user.id, siteIds: [de] });

    await as(a.token).put("/monitoring/domains/berlin.de/expiry", { expiresAt: null }).expect(200);
    const cleared = await as(a.token).get(`/sites/${de}/expiry`).expect(200);
    expect(cleared.body.domains[0]).toMatchObject({ expiresAt: null, manual: false });
  });

  it("records a runner failure for the schedule and audits it", async () => {
    const a = await user("ADMIN");
    await site(a.token, "Shop", "https://shop.com");
    const { RunnerUnavailableError } = await import("../runner/client");
    failWith = new RunnerUnavailableError("down");
    await runAll();
    const overview = await as(a.token).get("/monitoring/expiry").expect(200);
    expect(overview.body.status).toMatchObject({
      ok: false,
      error: "The runner did not answer in time.",
    });
    const rows = await db.auditLog.findMany({ where: { action: "monitor.expiry.check" } });
    expect(rows[0]).toMatchObject({ result: "failure" });
  });

  it("Check now: one site, needs sites.refresh, refuses archived sites, audited", async () => {
    const a = await user("ADMIN");
    const v = await user("VIEWER");
    const d = await user("DEVELOPER");
    const shop = await site(a.token, "Shop", "https://shop.com");
    await site(a.token, "Other", "https://other.com");
    answers = { "shop.com": { ssl: cert("shop.com", 60), domain: domain("shop.com", 300) } };
    await as(v.token).post(`/sites/${shop}/expiry-check`).expect(403);
    await as(v.token).get(`/sites/${shop}/expiry`).expect(200);
    await as(d.token).post(`/sites/${shop}/expiry-check`).expect(202);
    await lastExpiryRun();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      type: "monitor.expiry",
      checks: [{ host: "shop.com", port: 443, ssl: true, domain: true }],
    });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "monitor.expiry.check" } });
    expect(audit).toMatchObject({ userId: d.user.id, siteIds: [shop], ip: "203.0.113.10" });
    // A single-site check doesn't count as the daily run.
    const overview = await as(a.token).get("/monitoring/expiry").expect(200);
    expect(overview.body.status.lastSuccessAt).toBeNull();

    await db.site.update({ where: { id: shop }, data: { archived: true } });
    await as(d.token).post(`/sites/${shop}/expiry-check`).expect(409);
  });
});
