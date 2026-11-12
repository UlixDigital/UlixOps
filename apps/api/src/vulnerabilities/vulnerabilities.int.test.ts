// Vulnerability feed sync, matching, and the Security endpoints (real Postgres, stub runner).
import type { RunnerJob, VulnFeedResult, VulnRecord } from "@ulixops/shared";
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
import { isSyncing, readFeedStatus, rematchEnvironment, syncVulnerabilities } from "./service";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 9, 31, 9, 0, 0));

const production = {
  url: "https://shop.example.test",
  sshHost: "shop.ssh.example.test",
  sshPort: 22,
  sshUser: "shop",
  wpPath: "/sites/shop",
  credentialRef: "SHOP_SSH_KEY",
};

const AKISMET_XSS: VulnRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  title: "Akismet <= 4.1 - Stored XSS",
  severity: "high",
  cvssScore: 7.2,
  cve: "CVE-2025-00001",
  reference: "https://www.wordfence.com/threat-intel/vulnerabilities/id/1111",
  publishedAt: "2025-01-01T00:00:00.000Z",
  software: [
    {
      type: "plugin",
      slug: "akismet",
      ranges: [{ from: "*", fromInclusive: true, to: "4.1", toInclusive: true }],
      patchedVersions: ["4.2"],
    },
  ],
};
const CORE_LOW: VulnRecord = {
  ...AKISMET_XSS,
  id: "99999999-2222-3333-4444-555555555555",
  title: "WordPress Core < 6.5 - Information Disclosure",
  severity: "low",
  cvssScore: 3.1,
  cve: null,
  software: [
    {
      type: "core",
      slug: "wordpress",
      ranges: [{ from: "*", fromInclusive: true, to: "6.5", toInclusive: false }],
      patchedVersions: ["6.5"],
    },
  ],
};

const item = (name: string, version: string) => ({
  name,
  title: name,
  status: "active" as const,
  version,
  updateVersion: null,
});

describe.runIf(TEST_DATABASE_URL)("vulnerability scanning (Postgres)", () => {
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
  let feed: VulnFeedResult = {
    ok: true,
    fetchedAt: NOW.toISOString(),
    total: 1234,
    records: [AKISMET_XSS, CORE_LOW],
  };
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      return feed;
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
      get: (path: string) => set(request(app).get(path)),
      post: (path: string, body: object = {}) => set(request(app).post(path)).send(body),
    };
  };
  const make = (role: "ADMIN" | "DEVELOPER" | "VIEWER") =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW });

  async function siteWithInventory(
    admin: string,
    plugins: ReturnType<typeof item>[],
    wpVersion = "6.4.2",
  ) {
    const res = await as(admin)
      .post("/sites", { name: "Shop", host: "WPENGINE", tags: [], production, staging: null })
      .expect(201);
    const siteId = res.body.id as string;
    const env = await db.siteEnvironment.findFirstOrThrow({ where: { siteId } });
    await db.siteInventory.create({
      data: {
        environmentId: env.id,
        refreshedAt: NOW,
        wpVersion,
        phpVersion: "8.3.1",
        wpCliVersion: "2.12.0",
        warnings: [],
        plugins,
        themes: [item("twentytwentyfour", "1.0")],
      },
    });
    return { siteId, environmentId: env.id };
  }

  beforeEach(async () => {
    await resetData(ownerUrl);
    notices = [];
    jobs = [];
    feed = {
      ok: true,
      fetchedAt: NOW.toISOString(),
      total: 1234,
      records: [AKISMET_XSS, CORE_LOW],
    };
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("syncs the feed, opens findings, alerts and audits", async () => {
    const admin = await make("ADMIN");
    const { siteId } = await siteWithInventory(admin.token, [
      item("akismet", "4.0"),
      item("hello", "1.7.2"),
    ]);

    const outcome = await syncVulnerabilities(deps, { userId: admin.user.id, ip: "203.0.113.10" });
    expect(outcome).toEqual({ ok: true, records: 2, total: 1234, opened: 2 });

    // Only software we run was asked for, and nothing secret went in the job.
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job?.type).toBe("vuln.feed");
    if (job?.type === "vuln.feed")
      expect(job.wanted).toEqual(
        expect.arrayContaining([
          { type: "core", slug: "wordpress" },
          { type: "plugin", slug: "akismet" },
          { type: "plugin", slug: "hello" },
          { type: "theme", slug: "twentytwentyfour" },
        ]),
      );

    const list = await as(admin.token).get("/vulnerabilities").expect(200);
    expect(list.body.findings).toMatchObject([
      {
        siteId,
        siteName: "Shop",
        environment: "PRODUCTION",
        type: "plugin",
        slug: "akismet",
        installedVersion: "4.0",
        fixedIn: "4.2",
        severity: "high",
        resolvedAt: null,
      },
      { type: "core", slug: "wordpress", installedVersion: "6.4.2", severity: "low" },
    ]);
    expect(list.body.feed).toMatchObject({ ok: true, records: 2, total: 1234, running: false });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "vulnerability.found",
      severity: "critical",
      siteIds: [siteId],
      title: "2 new vulnerabilities on 1 site",
    });
    expect(notices[0]?.body.split("\n")[0]).toContain("High: Shop · akismet 4.0");

    const auditRow = await db.auditLog.findFirstOrThrow({
      where: { action: "vulnerabilities.sync" },
    });
    expect(auditRow).toMatchObject({ result: "success", userId: admin.user.id, siteIds: [siteId] });

    // The sites list carries the open count and worst severity.
    const sites = await as(admin.token).get("/sites").expect(200);
    expect(sites.body.sites[0].environments[0].vulnerabilities).toEqual({
      open: 2,
      worst: "high",
    });

    // A second sync with nothing new stays quiet.
    await syncVulnerabilities(deps, { userId: null, ip: null });
    expect(notices).toHaveLength(1);
  });

  it("resolves findings when the installed version is fixed, and reopens them", async () => {
    const admin = await make("ADMIN");
    const { siteId, environmentId } = await siteWithInventory(admin.token, [
      item("akismet", "4.1"),
    ]);
    await syncVulnerabilities(deps, { userId: admin.user.id, ip: null });

    await db.siteInventory.update({
      where: { environmentId },
      data: { plugins: [item("akismet", "4.2")], wpVersion: "6.5" },
    });
    expect(await rematchEnvironment(db, environmentId, NOW)).toEqual([]);
    expect((await as(admin.token).get("/vulnerabilities").expect(200)).body.findings).toEqual([]);
    const resolved = await as(admin.token).get("/vulnerabilities?status=resolved").expect(200);
    expect(resolved.body.findings).toHaveLength(2);
    const site = await as(admin.token).get(`/sites/${siteId}/vulnerabilities`).expect(200);
    expect(site.body.findings.every((f: { resolvedAt: string }) => f.resolvedAt)).toBe(true);

    // Downgraded again: the same finding reopens and counts as new.
    await db.siteInventory.update({
      where: { environmentId },
      data: { plugins: [item("akismet", "3.9")] },
    });
    const reopened = await rematchEnvironment(db, environmentId, NOW);
    expect(reopened).toMatchObject([{ slug: "akismet", installedVersion: "3.9" }]);
    expect(await db.vulnerabilityFinding.count()).toBe(2);
  });

  it("records a failed sync with a plain reason and an audit row", async () => {
    const admin = await make("ADMIN");
    await siteWithInventory(admin.token, [item("akismet", "4.0")]);
    feed = {
      ok: false,
      reason: "not_configured",
      detail: "Add a Wordfence Intelligence API key to the vault as WORDFENCE_API_KEY.",
    };
    expect(await syncVulnerabilities(deps, { userId: null, ip: null })).toMatchObject({
      ok: false,
    });
    expect(await readFeedStatus(db)).toMatchObject({
      ok: false,
      lastSuccessAt: null,
      error: expect.stringContaining("WORDFENCE_API_KEY"),
    });
    expect(
      await db.auditLog.findFirstOrThrow({ where: { action: "vulnerabilities.sync" } }),
    ).toMatchObject({ result: "failure", userId: null });
    expect(await db.vulnerabilityFinding.count()).toBe(0);
  });

  it("refuses to sync without any inventory", async () => {
    const admin = await make("ADMIN");
    expect(await syncVulnerabilities(deps, { userId: admin.user.id, ip: null })).toMatchObject({
      ok: false,
      error: expect.stringContaining("No site has an inventory"),
    });
    expect(jobs).toHaveLength(0);
  });

  it("lets only Admins start a sync, and everyone with sites.view read findings", async () => {
    const admin = await make("ADMIN");
    const viewer = await userWithSession(db, "VIEWER", {
      sessionSecret: SECRET,
      now: NOW,
      email: "viewer@example.test",
    });
    const developer = await userWithSession(db, "DEVELOPER", {
      sessionSecret: SECRET,
      now: NOW,
      email: "dev@example.test",
    });
    await siteWithInventory(admin.token, [item("akismet", "4.0")]);

    await as(viewer.token).post("/vulnerabilities/sync").expect(403);
    await as(developer.token).post("/vulnerabilities/sync").expect(403);
    await as(viewer.token).get("/vulnerabilities").expect(200);
    await as(viewer.token).get("/vulnerabilities?status=bogus").expect(400);

    await as(admin.token).post("/vulnerabilities/sync").expect(202);
    for (let i = 0; i < 50 && isSyncing(); i++) await new Promise((r) => setTimeout(r, 20));
    expect((await readFeedStatus(db)).ok).toBe(true);
  });

  it("hides archived sites from the Security page", async () => {
    const admin = await make("ADMIN");
    const { siteId } = await siteWithInventory(admin.token, [item("akismet", "4.0")]);
    await syncVulnerabilities(deps, { userId: null, ip: null });
    await db.site.update({ where: { id: siteId }, data: { archived: true } });
    expect((await as(admin.token).get("/vulnerabilities").expect(200)).body.findings).toEqual([]);
  });
});
