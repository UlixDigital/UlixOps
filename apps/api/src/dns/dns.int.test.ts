// Cloudflare DNS (A156) against Postgres with a fake runner that behaves like Cloudflare: change
// alerts for outside edits, snapshots around every UlixOps edit, rollback only after a second
// Admin approves, purge, checklist and permissions.
import type { DnsChangeOp, DnsRecord, RunnerJob } from "@ulixops/shared";
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
import { syncDns } from "./service";

const SECRET = "s".repeat(64);
const NOW = new Date(Date.UTC(2026, 10, 1, 9, 0, 0));
const ZONE = "a".repeat(32);
const hex = (n: number) => n.toString(16).padStart(32, "0");

describe.runIf(TEST_DATABASE_URL)("Cloudflare DNS (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  const now = () => NOW;
  let notices: NotifyInput[] = [];
  const notifier = {
    alert: async (_e: SecurityAlertEvent) => undefined,
    notify: async (input: NotifyInput) => {
      notices.push(input);
    },
  };
  // The fake Cloudflare zone.
  let records: DnsRecord[] = [];
  let tokenSet = true;
  let n = 100;
  let jobs: RunnerJob[] = [];
  const rec = (
    id: number,
    type: string,
    name: string,
    content: string,
    extra: Partial<DnsRecord> = {},
  ): DnsRecord => ({
    id: hex(id),
    type,
    name,
    content,
    ttl: 1,
    proxied: false,
    priority: null,
    comment: null,
    ...extra,
  });
  const apply = (changes: DnsChangeOp[]) => {
    let applied = 0;
    for (const c of changes) {
      if (c.op === "create") records.push({ id: hex(++n), ...c.record });
      else if (c.op === "update")
        records = records.map((r) => (r.id === c.id ? { id: c.id, ...c.record } : r));
      else records = records.filter((r) => r.id !== c.id);
      applied++;
    }
    return { applied, failed: null };
  };
  const runner: RunnerClient = {
    run: async (job) => {
      jobs.push(job);
      const noToken = {
        ok: false,
        error: "No Cloudflare API token in the vault (Settings → Credentials).",
      };
      switch (job.type) {
        case "dns.zones":
          return tokenSet
            ? {
                ok: true,
                zones: [
                  {
                    id: ZONE,
                    name: "shop.example",
                    status: "active",
                    paused: false,
                    accountName: "Ulix Digital",
                    plan: "Free Website",
                    nameServers: ["ana.ns.cloudflare.com"],
                    originalNameServers: ["ns1.godaddy.com"],
                    originalRegistrar: null,
                  },
                ],
              }
            : noToken;
        case "dns.records":
          return tokenSet ? { ok: true, records } : noToken;
        case "dns.apply":
          return apply(job.changes);
        case "dns.purge":
          return { ok: true };
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
  const app = createApp({ auth, db, now, notifier, runner, sessionSecret: SECRET });
  const deps = { db, now, runner, notifier };
  const as = (token: string) => {
    const set = (r: request.Test) =>
      r.set("authorization", `Bearer ${token}`).set("x-ulix-client-ip", "203.0.113.10");
    return {
      get: (p: string) => set(request(app).get(p)),
      post: (p: string, body: object = {}) => set(request(app).post(p)).send(body),
      put: (p: string, body: object = {}) => set(request(app).put(p)).send(body),
      delete: (p: string) => set(request(app).delete(p)),
    };
  };
  const user = (role: "ADMIN" | "DEVELOPER", email: string) =>
    userWithSession(db, role, { sessionSecret: SECRET, now: NOW, email });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const www = {
    type: "A",
    name: "www",
    content: "203.0.113.5",
    ttl: 1,
    proxied: true,
    priority: null,
    comment: null,
  };

  beforeEach(async () => {
    await resetData(ownerUrl);
    notices = [];
    jobs = [];
    tokenSet = true;
    records = [
      rec(1, "A", "shop.example", "141.193.213.10", { proxied: true }),
      rec(2, "MX", "shop.example", "mx.mail.example", { priority: 10 }),
      rec(3, "NS", "dev.shop.example", "ns1.elsewhere.net", { ttl: 3600 }),
    ];
  });
  afterAll(() => db.$disconnect());

  it("says when the token is missing", async () => {
    tokenSet = false;
    const a = await user("ADMIN", "a@example.test");
    await syncDns(deps, { userId: null, ip: null });
    const body = (await as(a.token).get("/dns").expect(200)).body;
    expect(body).toMatchObject({ tokenSet: false, status: { ok: false }, zones: [] });
  });

  it("snapshots on first sight, then alerts on a change made outside UlixOps", async () => {
    const a = await user("ADMIN", "a@example.test");
    await as(a.token)
      .post("/sites", {
        name: "Shop",
        host: "OTHER",
        tags: [],
        production: {
          url: "https://www.shop.example",
          sshHost: "shop.ssh.wpengine.net",
          sshPort: 22,
          sshUser: "shop",
          wpPath: "/sites/shop",
          credentialRef: "SHOP_KEY",
        },
        staging: null,
      })
      .expect(201);
    await syncDns(deps, { userId: null, ip: null });
    expect(await db.dnsSnapshot.count()).toBe(1);
    expect(notices).toEqual([]);

    records = [...records, rec(9, "TXT", "shop.example", "v=spf1 -all")];
    await syncDns(deps, { userId: null, ip: null });
    const overview = (await as(a.token).get("/dns").expect(200)).body;
    expect(overview.zones[0]).toMatchObject({
      name: "shop.example",
      recordCount: 4,
      externalChanges7d: 1,
      site: { name: "Shop" },
    });
    expect(notices).toMatchObject([{ kind: "dns.changed", severity: "warning" }]);
    expect(notices[0]?.body).toContain("+ TXT shop.example → v=spf1 -all");
    expect(await db.auditLog.count({ where: { action: "dns.external_change" } })).toBe(1);
    // Nothing new: no second alert.
    await syncDns(deps, { userId: null, ip: null });
    expect(notices).toHaveLength(1);
  });

  it("adds, edits and deletes records with snapshots around each, and no false alert after", async () => {
    const a = await user("ADMIN", "a@example.test");
    await syncDns(deps, { userId: null, ip: null });
    await as(a.token).post(`/dns/zones/${ZONE}/records`, www).expect(200);
    expect(records.find((r) => r.name === "www.shop.example")).toMatchObject({ proxied: true });
    const added = records.find((r) => r.name === "www.shop.example");
    await as(a.token)
      .put(`/dns/zones/${ZONE}/records/${added?.id}`, { ...www, content: "203.0.113.6" })
      .expect(200);
    await as(a.token).delete(`/dns/zones/${ZONE}/records/${added?.id}`).expect(200);
    expect(records.some((r) => r.name === "www.shop.example")).toBe(false);

    const detail = (await as(a.token).get(`/dns/zones/${ZONE}`).expect(200)).body;
    expect(detail.changes.map((c: { summary: string }) => c.summary)).toEqual([
      "Deleted A www.shop.example",
      "Edited A www.shop.example",
      "Added A www.shop.example",
    ]);
    expect(detail.changes[2].lines).toEqual(["+ A www.shop.example → 203.0.113.5"]);
    expect(await db.dnsSnapshot.count({ where: { reason: "before-change" } })).toBe(3);
    expect(await db.auditLog.count({ where: { action: { startsWith: "dns.record." } } })).toBe(3);
    await syncDns(deps, { userId: null, ip: null });
    expect(notices.filter((x) => x.kind === "dns.changed")).toEqual([]);
  });

  it("refuses names outside the zone, bad values, unmanaged types and non-Admins", async () => {
    const a = await user("ADMIN", "a@example.test");
    const dev = await user("DEVELOPER", "d@example.test");
    await syncDns(deps, { userId: null, ip: null });
    await as(a.token)
      .post(`/dns/zones/${ZONE}/records`, { ...www, name: "www.other.example." })
      .expect(400);
    await as(a.token)
      .post(`/dns/zones/${ZONE}/records`, { ...www, content: "1.2.3" })
      .expect(400);
    await as(a.token)
      .post(`/dns/zones/${ZONE}/records`, { ...www, type: "NS" })
      .expect(400);
    const ns = await as(a.token)
      .delete(`/dns/zones/${ZONE}/records/${hex(3)}`)
      .expect(409);
    expect(ns.body.error).toBe("record_not_managed");
    await as(dev.token).post(`/dns/zones/${ZONE}/records`, www).expect(403);
    await as(dev.token).post(`/dns/zones/${ZONE}/rollback`, { snapshotId: "x1" }).expect(403);
    expect(jobs.filter((j) => j.type === "dns.apply")).toEqual([]);
  });

  it("rolls back to a snapshot only after another Admin approves", async () => {
    const a = await user("ADMIN", "a@example.test");
    const b = await user("ADMIN", "b@example.test");
    await syncDns(deps, { userId: null, ip: null });
    const good = await db.dnsSnapshot.findFirstOrThrow();
    // Someone breaks it in Cloudflare: the apex A record now points elsewhere, MX gone.
    records = [
      rec(1, "A", "shop.example", "10.0.0.1", { proxied: true }),
      rec(3, "NS", "dev.shop.example", "ns1.elsewhere.net", { ttl: 3600 }),
    ];
    await syncDns(deps, { userId: null, ip: null });

    const asked = await as(a.token)
      .post(`/dns/zones/${ZONE}/rollback`, { snapshotId: good.id })
      .expect(202);
    expect(asked.body.selfApproved).toBe(false);
    expect(jobs.filter((j) => j.type === "dns.apply")).toEqual([]);
    await as(a.token).post(`/dns/zones/${ZONE}/rollback`, { snapshotId: good.id }).expect(409);
    const req = await db.approvalRequest.findFirstOrThrow({ where: { action: "dns.rollback" } });
    await as(a.token).post(`/approvals/${req.id}/approve`).expect(409); // own request
    await as(b.token).post(`/approvals/${req.id}/approve`).expect(200);
    await settle();

    expect(records.map((r) => `${r.type} ${r.content}`).sort()).toEqual([
      "A 141.193.213.10",
      "MX mx.mail.example",
      "NS ns1.elsewhere.net",
    ]);
    expect(await db.dnsRollback.findFirstOrThrow()).toMatchObject({ status: "APPLIED" });
    const detail = (await as(a.token).get(`/dns/zones/${ZONE}`).expect(200)).body;
    expect(detail.changes[0]).toMatchObject({ kind: "rollback", ok: true });
    expect(detail.pendingRollback).toBeNull();
    expect(
      await db.auditLog.count({ where: { action: "dns.rollback.result", result: "success" } }),
    ).toBe(1);
  });

  it("lets Developers purge the cache, only for the zone's own URLs", async () => {
    const dev = await user("DEVELOPER", "d@example.test");
    await syncDns(deps, { userId: null, ip: null });
    await as(dev.token).post(`/dns/zones/${ZONE}/purge`, { everything: true }).expect(200);
    await as(dev.token)
      .post(`/dns/zones/${ZONE}/purge`, { everything: false, urls: ["https://evil.example/x"] })
      .expect(400);
    await as(dev.token)
      .post(`/dns/zones/${ZONE}/purge`, { everything: false, urls: ["https://www.shop.example/a"] })
      .expect(200);
    expect(jobs.filter((j) => j.type === "dns.purge")).toHaveLength(2);
    expect(await db.auditLog.count({ where: { action: "dns.cache.purge" } })).toBe(2);
  });

  it("keeps the migration checklist: manual steps ticked, automatic ones from Cloudflare", async () => {
    const a = await user("ADMIN", "a@example.test");
    await syncDns(deps, { userId: null, ip: null });
    await as(a.token)
      .put(`/dns/zones/${ZONE}/checklist`, { key: "ssl_mode", done: true })
      .expect(200);
    await as(a.token)
      .put(`/dns/zones/${ZONE}/checklist`, { key: "zone_active", done: false })
      .expect(400);
    const list = (await as(a.token).get(`/dns/zones/${ZONE}`).expect(200)).body.checklist as {
      key: string;
      done: boolean;
    }[];
    expect(list.find((s) => s.key === "ssl_mode")?.done).toBe(true);
    expect(list.find((s) => s.key === "zone_active")?.done).toBe(true);
    expect(list.find((s) => s.key === "records_copied")?.done).toBe(false);
  });
});
