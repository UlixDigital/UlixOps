// DNS screen (spec screen 15, A156): zones, records, edits, snapshots + rollback request,
// change history, migration checklist and cache purge. Viewing: sites.view; refreshing from
// Cloudflare: sites.refresh; record edits and rollback requests: dns.manage (Admin); cache
// purge: site.emergency (like flushing a site's cache).
import {
  CfId,
  DnsChangeKind,
  type DnsChangeView,
  DnsRecordInput,
  DnsRecordValue,
  type DnsSnapshotView,
  type DnsZoneDetail,
  type DnsZoneView,
  fullRecordName,
  planRollback,
  PurgeRequest,
  RecordId,
  SetChecklistItem,
} from "@ulixops/shared";
import { type Response, Router } from "express";
import { z } from "zod";
import type { Db } from "../db";
import type { DnsZone } from "../generated/prisma/client";
import { authorize, clientIpOf, sessionOf } from "../http/guard";
import { emailsOf } from "../malware/service";
import { callRunner } from "../sites/routes";
import {
  changeRecord,
  checklistOf,
  type DnsDeps,
  isDnsSyncing,
  purgeZone,
  readDnsStatus,
  recordsOf,
  requestDnsRollback,
  setChecklistItem,
  sitesInZone,
  statusView,
  syncDns,
} from "./service";

type Deps = DnsDeps;

const WEEK_MS = 7 * 86_400_000;

async function zoneViews(db: Db, zones: DnsZone[], at: Date): Promise<DnsZoneView[]> {
  const ids = zones.map((z) => z.id);
  const [last, external] = await Promise.all([
    db.dnsChange.groupBy({ by: ["zoneId"], where: { zoneId: { in: ids } }, _max: { at: true } }),
    db.dnsChange.groupBy({
      by: ["zoneId"],
      where: {
        zoneId: { in: ids },
        kind: "external",
        at: { gte: new Date(at.getTime() - WEEK_MS) },
      },
      _count: { _all: true },
    }),
  ]);
  const lastAt = new Map(last.map((l) => [l.zoneId, l._max.at]));
  const ext = new Map(external.map((e) => [e.zoneId, e._count._all]));
  return Promise.all(
    zones.map(async (z) => {
      const site = (await sitesInZone(db, z.name))[0] ?? null;
      return {
        id: z.id,
        name: z.name,
        status: z.status,
        paused: z.paused,
        accountName: z.accountName,
        plan: z.plan,
        nameServers: z.nameServers,
        originalNameServers: z.originalNameServers,
        recordCount: z.recordCount,
        site,
        lastSyncAt: z.lastSyncAt?.toISOString() ?? null,
        lastChangeAt: lastAt.get(z.id)?.toISOString() ?? null,
        externalChanges7d: ext.get(z.id) ?? 0,
        removed: z.removedAt !== null,
      };
    }),
  );
}

export function dnsRouter(deps: Deps): Router {
  const { db, now } = deps;
  const router = Router();
  const canView = authorize("sites.view", deps);
  const canRefresh = authorize("sites.refresh", deps);
  const canManage = authorize("dns.manage", deps);
  const canPurge = authorize("site.emergency", deps);

  const zoneOr404 = async (raw: unknown, res: Response) => {
    const id = CfId.safeParse(raw);
    const zone = id.success ? await db.dnsZone.findUnique({ where: { id: id.data } }) : null;
    if (!zone) res.status(404).json({ error: "not_found" });
    return zone;
  };

  router.get("/", canView, async (_req, res) => {
    const status = await readDnsStatus(db);
    const zones = await db.dnsZone.findMany({ orderBy: { name: "asc" } });
    res.json({
      tokenSet: !status.tokenMissing,
      status: statusView({ ...status, running: status.running && isDnsSyncing() }),
      zones: await zoneViews(db, zones, now()),
    });
  });

  router.post("/sync", canRefresh, (req, res) => {
    if (isDnsSyncing()) {
      res.status(202).json({ started: false });
      return;
    }
    void syncDns(deps, { userId: sessionOf(req).user.id, ip: clientIpOf(req) });
    res.status(202).json({ started: true });
  });

  router.get("/zones/:id", canView, async (req, res) => {
    const zone = await zoneOr404(req.params.id, res);
    if (!zone) return;
    const [snapshots, changes, pending] = await Promise.all([
      db.dnsSnapshot.findMany({
        where: { zoneId: zone.id },
        orderBy: [{ takenAt: "desc" }, { id: "desc" }],
        take: 30,
      }),
      db.dnsChange.findMany({
        where: { zoneId: zone.id },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take: 50,
      }),
      db.dnsRollback.findFirst({
        where: { zoneId: zone.id, status: { in: ["PENDING_APPROVAL", "APPROVED"] } },
        select: { approvalId: true, snapshotId: true },
      }),
    ]);
    const current = recordsOf(snapshots[0]?.records);
    const emails = await emailsOf(
      db,
      changes.map((c) => c.userId),
    );
    const changeViews: DnsChangeView[] = changes.map((c) => ({
      id: c.id,
      kind: DnsChangeKind.catch("external").parse(c.kind),
      at: c.at.toISOString(),
      by: c.userId ? (emails.get(c.userId) ?? null) : null,
      summary: c.summary,
      lines: c.lines,
      ok: c.ok,
    }));
    const snapshotViews: DnsSnapshotView[] = snapshots.map((s) => ({
      id: s.id,
      takenAt: s.takenAt.toISOString(),
      reason: s.reason,
      recordCount: s.recordCount,
      differences: planRollback(current, recordsOf(s.records)).length,
    }));
    const [view] = await zoneViews(db, [zone], now());
    if (!view) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body: DnsZoneDetail = {
      zone: view,
      records: current,
      changes: changeViews,
      snapshots: snapshotViews,
      checklist: checklistOf(zone),
      pendingRollback: pending?.approvalId
        ? { requestId: pending.approvalId, snapshotId: pending.snapshotId }
        : null,
    };
    res.json(body);
  });

  router.post("/zones/:id/sync", canRefresh, async (req, res) => {
    const zone = await zoneOr404(req.params.id, res);
    if (!zone) return;
    const status = await callRunner(res, () =>
      syncDns(deps, { userId: sessionOf(req).user.id, ip: clientIpOf(req) }, zone.id),
    );
    if (status === null) return;
    res.json(statusView(status));
  });

  /** Validates a record against the zone: the name must sit inside it. */
  const recordFrom = (body: unknown, zone: string) => {
    const input = DnsRecordInput.safeParse(body);
    if (!input.success) return { error: "bad_request" as const };
    const name = fullRecordName(input.data.name, zone);
    if (!name) return { error: "record_outside_zone" as const };
    const value = DnsRecordValue.safeParse({ ...input.data, name });
    return value.success ? { value: value.data } : { error: "bad_request" as const };
  };

  const send = async (res: Response, run: () => ReturnType<typeof changeRecord>) => {
    const result = await callRunner(res, run);
    if (result === null) return;
    if (result.ok) {
      res.json({ ok: true });
      return;
    }
    const status = result.error === "not_found" ? 404 : result.error === "dns_failed" ? 502 : 409;
    res.status(status).json({ error: result.error, detail: result.detail });
  };

  router.post("/zones/:id/records", canManage, async (req, res) => {
    const zone = await zoneOr404(req.params.id, res);
    if (!zone) return;
    const record = recordFrom(req.body, zone.name);
    if ("error" in record) {
      res.status(400).json({ error: record.error });
      return;
    }
    const user = sessionOf(req).user;
    await send(res, () =>
      changeRecord(
        deps,
        zone.id,
        { op: "create", record: record.value },
        { userId: user.id, ip: clientIpOf(req) },
      ),
    );
  });

  router.put("/zones/:id/records/:recordId", canManage, async (req, res) => {
    const zone = await zoneOr404(req.params.id, res);
    if (!zone) return;
    const recordId = CfId.safeParse(req.params.recordId);
    const record = recordFrom(req.body, zone.name);
    if (!recordId.success || "error" in record) {
      res.status(400).json({ error: "error" in record ? record.error : "bad_request" });
      return;
    }
    const user = sessionOf(req).user;
    await send(res, () =>
      changeRecord(
        deps,
        zone.id,
        { op: "update", id: recordId.data, record: record.value },
        { userId: user.id, ip: clientIpOf(req) },
      ),
    );
  });

  router.delete("/zones/:id/records/:recordId", canManage, async (req, res) => {
    const zone = await zoneOr404(req.params.id, res);
    if (!zone) return;
    const recordId = CfId.safeParse(req.params.recordId);
    if (!recordId.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const user = sessionOf(req).user;
    await send(res, () =>
      changeRecord(
        deps,
        zone.id,
        { op: "delete", id: recordId.data },
        { userId: user.id, ip: clientIpOf(req) },
      ),
    );
  });

  router.post("/zones/:id/rollback", canManage, async (req, res) => {
    const zone = await zoneOr404(req.params.id, res);
    if (!zone) return;
    const body = z.object({ snapshotId: RecordId }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const asked = await requestDnsRollback(
      deps,
      zone.id,
      body.data.snapshotId,
      sessionOf(req).user,
      clientIpOf(req),
    );
    if (!asked.ok) {
      res.status(asked.error === "not_found" ? 404 : 409).json({ error: asked.error });
      return;
    }
    res.status(202).json({ rollbackId: asked.rollbackId, selfApproved: asked.selfApproved });
  });

  router.post("/zones/:id/purge", canPurge, async (req, res) => {
    const zone = await zoneOr404(req.params.id, res);
    if (!zone) return;
    const body = PurgeRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const user = sessionOf(req).user;
    const result = await callRunner(res, () =>
      purgeZone(deps, zone.id, body.data, { userId: user.id, ip: clientIpOf(req) }),
    );
    if (result === null) return;
    if (!result.ok) {
      res
        .status(
          result.error === "not_found" ? 404 : result.error === "record_outside_zone" ? 400 : 502,
        )
        .json({ error: result.error, detail: result.detail });
      return;
    }
    res.json({ ok: true });
  });

  router.put("/zones/:id/checklist", canManage, async (req, res) => {
    const zone = await zoneOr404(req.params.id, res);
    if (!zone) return;
    const body = SetChecklistItem.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const user = sessionOf(req).user;
    const ok = await setChecklistItem(deps, zone.id, body.data.key, body.data.done, {
      userId: user.id,
      ip: clientIpOf(req),
    });
    if (!ok) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
