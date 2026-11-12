// Cloudflare DNS (Phase 3 step 3, A156). The runner talks to Cloudflare; this keeps the zones,
// snapshots and change history, alerts on changes made outside UlixOps, and runs record edits,
// rollbacks (after approval) and cache purges, one change per zone at a time.
import {
  describeDiff,
  diffRecords,
  type DnsApplyResult,
  DnsApplyResult as DnsApplyResultSchema,
  type DnsChangeOp,
  type DnsRecord,
  DnsRecord as DnsRecordSchema,
  DnsRecordsResult,
  type DnsSyncStatus,
  DnsZonesResult,
  MIGRATION_STEPS,
  type MigrationStepKey,
  planRollback,
  type RoleName,
  recordsFingerprint,
  DnsPurgeResult,
} from "@ulixops/shared";
import { z } from "zod";
import { type ApprovalsDeps, requestApproval, selfApproveIfAllowed } from "../approvals/routes";
import { audit } from "../audit";
import type { Db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import type { SecurityNotifier } from "../notify";
import type { RunnerClient } from "../runner/client";

export interface DnsDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier?: SecurityNotifier;
}

type Actor = { userId: string | null; ip: string | null };

export const STATUS_KEY = "dns.sync.status";
/** Change alerts: every zone is read again this often. */
export const DNS_SYNC_EVERY_MS = 6 * 60 * 60_000;
const JOB_TIMEOUT_MS = 60_000;
const SNAPSHOT_KEEP_DAYS = 90;
const SNAPSHOT_KEEP_MIN = 20;

const Records = z.array(DnsRecordSchema);
export const recordsOf = (json: unknown): DnsRecord[] => {
  const parsed = Records.safeParse(json);
  return parsed.success ? parsed.data : [];
};

// ---- Status --------------------------------------------------------------------------------

const StoredStatus = z.object({
  running: z.boolean(),
  startedAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
  tokenMissing: z.boolean(),
});
type StoredStatus = z.infer<typeof StoredStatus>;
const EMPTY: StoredStatus = {
  running: false,
  startedAt: null,
  lastRunAt: null,
  ok: null,
  error: null,
  tokenMissing: false,
};

export async function readDnsStatus(db: Db): Promise<StoredStatus> {
  const row = await db.setting.findUnique({ where: { key: STATUS_KEY } });
  const parsed = StoredStatus.safeParse(row?.value);
  return parsed.success ? parsed.data : EMPTY;
}

async function writeDnsStatus(db: Db, value: StoredStatus): Promise<void> {
  const json = value as unknown as Prisma.InputJsonObject;
  await db.setting.upsert({
    where: { key: STATUS_KEY },
    create: { key: STATUS_KEY, value: json },
    update: { value: json },
  });
}

export function statusView(s: StoredStatus): DnsSyncStatus {
  return { running: s.running, lastRunAt: s.lastRunAt, ok: s.ok, error: s.error };
}

export function dnsSyncDue(s: StoredStatus, at: Date): boolean {
  if (s.running) return false;
  if (!s.lastRunAt) return true;
  return at.getTime() - Date.parse(s.lastRunAt) >= DNS_SYNC_EVERY_MS;
}

// ---- Locks ---------------------------------------------------------------------------------

/** One change per zone at a time (one API process); a sync of that zone waits its turn too. */
const busy = new Set<string>();
let syncing = false;

async function withZone<T>(zoneId: string, run: () => Promise<T>): Promise<T | "busy"> {
  if (busy.has(zoneId)) return "busy";
  busy.add(zoneId);
  try {
    return await run();
  } finally {
    busy.delete(zoneId);
  }
}

// ---- Runner calls --------------------------------------------------------------------------

class DnsJobError extends Error {
  constructor(
    message: string,
    readonly tokenMissing = false,
  ) {
    super(message);
  }
}

async function fetchRecords(deps: DnsDeps, zoneId: string): Promise<DnsRecord[]> {
  const result = DnsRecordsResult.parse(
    await deps.runner.run({ type: "dns.records", zoneId }, JOB_TIMEOUT_MS),
  );
  if (!result.ok)
    throw new DnsJobError(result.error, result.error.startsWith("No Cloudflare API token"));
  return result.records;
}

async function applyOps(
  deps: DnsDeps,
  zoneId: string,
  changes: DnsChangeOp[],
): Promise<DnsApplyResult> {
  if (changes.length === 0) return { applied: 0, failed: null };
  return DnsApplyResultSchema.parse(
    await deps.runner.run({ type: "dns.apply", zoneId, changes }, JOB_TIMEOUT_MS * 5),
  );
}

async function snapshot(
  db: Db,
  zoneId: string,
  records: DnsRecord[],
  reason: string,
  userId: string | null,
  at: Date,
): Promise<string> {
  const row = await db.dnsSnapshot.create({
    data: {
      zoneId,
      takenAt: at,
      reason,
      takenById: userId,
      records: records as unknown as Prisma.InputJsonArray,
      recordCount: records.length,
      fingerprint: recordsFingerprint(records),
    },
  });
  await db.dnsZone.update({
    where: { id: zoneId },
    data: { recordCount: records.length, lastSyncAt: at },
  });
  return row.id;
}

const latestSnapshot = (db: Db, zoneId: string) =>
  db.dnsSnapshot.findFirst({ where: { zoneId }, orderBy: [{ takenAt: "desc" }, { id: "desc" }] });

// ---- Sync and change alerts ----------------------------------------------------------------

/**
 * Reads one zone's records and compares them with the last snapshot: a difference nobody made
 * through UlixOps is recorded, audited and alerted. The first read just takes a snapshot.
 */
async function syncZone(deps: DnsDeps, zone: { id: string; name: string }): Promise<void> {
  const { db, now } = deps;
  const records = await fetchRecords(deps, zone.id);
  const at = now();
  const last = await latestSnapshot(db, zone.id);
  if (!last) {
    await snapshot(db, zone.id, records, "first", null, at);
    return;
  }
  if (last.fingerprint === recordsFingerprint(records)) {
    await db.dnsZone.update({ where: { id: zone.id }, data: { lastSyncAt: at } });
    return;
  }
  const lines = describeDiff(diffRecords(recordsOf(last.records), records), 20);
  await snapshot(db, zone.id, records, "sync", null, at);
  await db.dnsChange.create({
    data: {
      zoneId: zone.id,
      at,
      userId: null,
      kind: "external",
      summary: "Changed outside UlixOps (in Cloudflare or by another tool)",
      lines,
      ok: true,
    },
  });
  const siteIds = await siteIdsFor(db, zone.name);
  await audit(
    db,
    {
      userId: null,
      action: "dns.external_change",
      result: "alert",
      ip: null,
      siteIds,
      meta: { zoneId: zone.id, zone: zone.name, lines: lines.slice(0, 10) },
    },
    at,
  );
  await deps.notifier?.notify?.({
    kind: "dns.changed",
    title: `DNS changed outside UlixOps: ${zone.name}`,
    body: `${lines.slice(0, 6).join("\n")}\nIf nobody on the team did this, roll back from the snapshot on the DNS page.`,
    severity: "warning",
    siteIds,
  });
}

/** Sites whose production URL is in this zone (for audit rows, alerts and the zone view). */
export async function sitesInZone(db: Db, zone: string) {
  const envs = await db.siteEnvironment.findMany({
    where: { kind: "PRODUCTION", site: { archived: false } },
    select: { url: true, site: { select: { id: true, name: true } } },
  });
  return envs
    .filter((e) => {
      try {
        const host = new URL(e.url).hostname.toLowerCase().replace(/^www\./, "");
        return host === zone || host.endsWith(`.${zone}`);
      } catch {
        return false;
      }
    })
    .map((e) => e.site);
}

const siteIdsFor = async (db: Db, zone: string) => (await sitesInZone(db, zone)).map((s) => s.id);

async function pruneSnapshots(db: Db, zoneId: string, at: Date): Promise<void> {
  const keep = await db.dnsSnapshot.findMany({
    where: { zoneId },
    orderBy: [{ takenAt: "desc" }, { id: "desc" }],
    take: SNAPSHOT_KEEP_MIN,
    select: { id: true },
  });
  await db.dnsSnapshot.deleteMany({
    where: {
      zoneId,
      takenAt: { lt: new Date(at.getTime() - SNAPSHOT_KEEP_DAYS * 86_400_000) },
      id: { notIn: keep.map((k) => k.id) },
      rollbacks: { none: { status: { in: ["PENDING_APPROVAL", "APPROVED"] } } },
    },
  });
}

/** Zones list, then every zone's records (or just `onlyZoneId`). Never two at once. */
export async function syncDns(
  deps: DnsDeps,
  actor: Actor,
  onlyZoneId?: string,
): Promise<StoredStatus> {
  const { db, now } = deps;
  if (syncing) return readDnsStatus(db);
  syncing = true;
  const started = now();
  const prev = await readDnsStatus(db);
  await writeDnsStatus(db, { ...prev, running: true, startedAt: started.toISOString() });
  let status: StoredStatus = {
    ...prev,
    running: false,
    startedAt: null,
    lastRunAt: started.toISOString(),
    ok: true,
    error: null,
    tokenMissing: false,
  };
  try {
    const zones = DnsZonesResult.parse(
      await deps.runner.run({ type: "dns.zones" }, JOB_TIMEOUT_MS),
    );
    if (!zones.ok)
      throw new DnsJobError(zones.error, zones.error.startsWith("No Cloudflare API token"));
    const at = now();
    for (const z of zones.zones) {
      const data = {
        name: z.name,
        status: z.status,
        paused: z.paused,
        accountName: z.accountName,
        plan: z.plan,
        nameServers: z.nameServers,
        originalNameServers: z.originalNameServers,
        removedAt: null,
      };
      await db.dnsZone.upsert({
        where: { id: z.id },
        create: { id: z.id, firstSeenAt: at, ...data },
        update: data,
      });
    }
    if (!onlyZoneId)
      await db.dnsZone.updateMany({
        where: { id: { notIn: zones.zones.map((z) => z.id) }, removedAt: null },
        data: { removedAt: at },
      });
    const failures: string[] = [];
    for (const z of zones.zones) {
      if (onlyZoneId && z.id !== onlyZoneId) continue;
      const done = await withZone(z.id, async () => {
        try {
          await syncZone(deps, z);
          await pruneSnapshots(db, z.id, now());
        } catch (error) {
          failures.push(`${z.name}: ${error instanceof Error ? error.message : "failed"}`);
        }
      });
      if (done === "busy") continue; // a change is running; it snapshots the zone itself
    }
    if (failures.length)
      status = { ...status, ok: false, error: failures.slice(0, 3).join("; ").slice(0, 500) };
    if (actor.userId)
      await audit(
        db,
        {
          userId: actor.userId,
          action: "dns.sync",
          result: failures.length ? "failure" : "success",
          ip: actor.ip,
          meta: { zones: zones.zones.length, only: onlyZoneId ?? null, failures: failures.length },
        },
        now(),
      );
  } catch (error) {
    const message =
      error instanceof DnsJobError
        ? error.message
        : error instanceof Error
          ? `The sync failed: ${error.message}`.slice(0, 300)
          : "The sync failed.";
    status = {
      ...status,
      ok: false,
      error: message,
      tokenMissing: error instanceof DnsJobError && error.tokenMissing,
    };
  } finally {
    syncing = false;
    await writeDnsStatus(db, status);
  }
  return status;
}

export const isDnsSyncing = () => syncing;

// ---- Record changes ------------------------------------------------------------------------

export type DnsChangeError =
  "not_found" | "dns_busy" | "dns_failed" | "record_not_managed" | "dns_token_missing";

const OP_LABEL = { create: "Added", update: "Edited", delete: "Deleted" } as const;

/**
 * One record change: read the zone fresh, snapshot it, apply, read again and snapshot, so the
 * history shows exactly what changed and the next sync doesn't call it an outside change.
 */
export async function changeRecord(
  deps: DnsDeps,
  zoneId: string,
  op: DnsChangeOp,
  actor: { userId: string; ip: string | null },
): Promise<{ ok: true } | { ok: false; error: DnsChangeError; detail?: string }> {
  const { db, now } = deps;
  const zone = await db.dnsZone.findUnique({ where: { id: zoneId } });
  if (!zone || zone.removedAt) return { ok: false, error: "not_found" };
  const outcome = await withZone(zoneId, async () => {
    let before: DnsRecord[];
    try {
      before = await fetchRecords(deps, zoneId);
    } catch (error) {
      return error instanceof DnsJobError && error.tokenMissing
        ? ({ ok: false, error: "dns_token_missing" } as const)
        : ({ ok: false, error: "dns_failed", detail: (error as Error).message } as const);
    }
    if (op.op !== "create") {
      const target = before.find((r) => r.id === op.id);
      if (!target) return { ok: false, error: "not_found" } as const;
      if (!["A", "AAAA", "CNAME", "TXT", "MX"].includes(target.type))
        return { ok: false, error: "record_not_managed" } as const;
    }
    await snapshot(db, zoneId, before, "before-change", actor.userId, now());
    const applied = await applyOps(deps, zoneId, [op]);
    let after: DnsRecord[] = before;
    try {
      after = await fetchRecords(deps, zoneId);
      await snapshot(db, zoneId, after, "after-change", actor.userId, now());
    } catch {
      // The change stands; the next sync will snapshot it.
    }
    const ok = applied.failed === null;
    const lines = ok
      ? describeDiff(diffRecords(before, after), 10)
      : [applied.failed?.error ?? "Failed"];
    const name =
      op.op === "delete" ? (before.find((r) => r.id === op.id)?.name ?? "") : op.record.name;
    const type =
      op.op === "delete" ? (before.find((r) => r.id === op.id)?.type ?? "") : op.record.type;
    const at = now();
    await db.dnsChange.create({
      data: {
        zoneId,
        at,
        userId: actor.userId,
        kind: op.op,
        summary: `${OP_LABEL[op.op]} ${type} ${name}${ok ? "" : " (failed)"}`,
        lines,
        ok,
      },
    });
    await audit(
      db,
      {
        userId: actor.userId,
        action: `dns.record.${op.op}`,
        result: ok ? "success" : "failure",
        ip: actor.ip,
        siteIds: await siteIdsFor(db, zone.name),
        meta: { zoneId, zone: zone.name, type, name, lines: lines.slice(0, 5) },
      },
      at,
    );
    return ok
      ? ({ ok: true } as const)
      : ({ ok: false, error: "dns_failed", detail: applied.failed?.error } as const);
  });
  return outcome === "busy" ? { ok: false, error: "dns_busy" } : outcome;
}

// ---- Rollback (needs approval) -------------------------------------------------------------

export async function requestDnsRollback(
  deps: DnsDeps,
  zoneId: string,
  snapshotId: string,
  user: { id: string; role: RoleName },
  ip: string | null,
): Promise<
  | { ok: true; rollbackId: string; selfApproved: boolean }
  | { ok: false; error: "not_found" | "already_pending" }
> {
  const { db, now } = deps;
  const snap = await db.dnsSnapshot.findFirst({
    where: { id: snapshotId, zoneId },
    include: { zone: true },
  });
  if (!snap || snap.zone.removedAt) return { ok: false, error: "not_found" };
  const at = now();
  const row = await db.dnsRollback.create({
    data: { zoneId, snapshotId, status: "PENDING_APPROVAL", requestedById: user.id, createdAt: at },
  });
  const asked = await requestApproval(
    db,
    {
      action: "dns.rollback",
      payload: {
        siteId: "",
        kind: zoneId,
        zone: snap.zone.name,
        rollbackId: row.id,
        snapshotId,
        takenAt: snap.takenAt.toISOString(),
      },
      requestedById: user.id,
      ip,
      requesterRole: user.role,
    },
    at,
    deps.notifier,
  );
  if (!asked.ok) {
    await db.dnsRollback.delete({ where: { id: row.id } });
    return { ok: false, error: asked.error };
  }
  await db.dnsRollback.update({ where: { id: row.id }, data: { approvalId: asked.id } });
  await audit(
    db,
    {
      userId: user.id,
      action: "dns.rollback.request",
      result: "pending",
      ip,
      siteIds: await siteIdsFor(db, snap.zone.name),
      meta: { zoneId, zone: snap.zone.name, snapshotId, requestId: asked.id },
    },
    at,
  );
  const approvals: ApprovalsDeps = {
    db,
    now,
    notifier: deps.notifier,
    onDnsRollbackDecided: (decision, rollbackId, decidedById) =>
      onDnsRollbackDecided(deps, decision, rollbackId, decidedById),
  };
  const selfApproved = await selfApproveIfAllowed(approvals, asked.id, user, ip);
  return { ok: true, rollbackId: row.id, selfApproved };
}

/** After the approval decision: run the rollback, or close it. */
export async function onDnsRollbackDecided(
  deps: DnsDeps,
  decision: "APPROVED" | "REJECTED",
  rollbackId: string,
  decidedById: string,
): Promise<void> {
  const { db, now } = deps;
  if (decision === "REJECTED") {
    await db.dnsRollback.updateMany({
      where: { id: rollbackId, status: "PENDING_APPROVAL" },
      data: { status: "REJECTED", finishedAt: now(), detail: "Rejected by an Admin." },
    });
    return;
  }
  await runRollback(deps, rollbackId, decidedById);
}

async function runRollback(deps: DnsDeps, rollbackId: string, decidedById: string): Promise<void> {
  const { db, now } = deps;
  const row = await db.dnsRollback.findUnique({
    where: { id: rollbackId },
    include: { zone: true, snapshot: true },
  });
  if (!row || row.status !== "APPROVED") return;
  const finish = async (ok: boolean, detail: string, lines: string[]) => {
    const at = now();
    await db.dnsRollback.update({
      where: { id: rollbackId },
      data: { status: ok ? "APPLIED" : "FAILED", finishedAt: at, detail: detail.slice(0, 1000) },
    });
    await db.dnsChange.create({
      data: {
        zoneId: row.zoneId,
        at,
        userId: row.requestedById,
        kind: "rollback",
        summary: `Rolled back to the snapshot of ${row.snapshot.takenAt.toISOString().slice(0, 16).replace("T", " ")} UTC${ok ? "" : " (failed)"}`,
        lines: lines.length ? lines : [detail],
        ok,
      },
    });
    await audit(
      db,
      {
        userId: row.requestedById,
        action: "dns.rollback.result",
        result: ok ? "success" : "failure",
        ip: null,
        siteIds: await siteIdsFor(db, row.zone.name),
        meta: {
          zoneId: row.zoneId,
          zone: row.zone.name,
          snapshotId: row.snapshotId,
          approvedBy: decidedById,
          detail: detail.slice(0, 300),
        },
      },
      at,
    );
  };
  const outcome = await withZone(row.zoneId, async () => {
    let current: DnsRecord[];
    try {
      current = await fetchRecords(deps, row.zoneId);
    } catch (error) {
      return finish(false, `Couldn't read the zone: ${(error as Error).message}`, []);
    }
    await snapshot(db, row.zoneId, current, "before-rollback", row.requestedById, now());
    const ops = planRollback(current, recordsOf(row.snapshot.records));
    if (ops.length === 0) return finish(true, "The zone already matched the snapshot.", []);
    const applied = await applyOps(deps, row.zoneId, ops);
    let after = current;
    try {
      after = await fetchRecords(deps, row.zoneId);
      await snapshot(db, row.zoneId, after, "after-rollback", row.requestedById, now());
    } catch {
      // The next sync snapshots it.
    }
    const lines = describeDiff(diffRecords(current, after), 20);
    return applied.failed
      ? finish(
          false,
          `${applied.applied} of ${ops.length} changes applied, then Cloudflare refused one: ${applied.failed.error}`,
          lines,
        )
      : finish(true, `${ops.length} change${ops.length === 1 ? "" : "s"} applied.`, lines);
  });
  if (outcome === "busy")
    await finish(
      false,
      "Another change to this domain was running. Request the rollback again.",
      [],
    );
}

// ---- Cache purge and checklist -------------------------------------------------------------

export async function purgeZone(
  deps: DnsDeps,
  zoneId: string,
  req: { everything: true } | { everything: false; urls: string[] },
  actor: { userId: string; ip: string | null },
): Promise<
  | { ok: true }
  | { ok: false; error: "not_found" | "dns_failed" | "record_outside_zone"; detail?: string }
> {
  const { db, now } = deps;
  const zone = await db.dnsZone.findUnique({ where: { id: zoneId } });
  if (!zone || zone.removedAt) return { ok: false, error: "not_found" };
  const urls = req.everything ? [] : req.urls;
  for (const u of urls) {
    const host = new URL(u).hostname.toLowerCase();
    if (host !== zone.name && !host.endsWith(`.${zone.name}`))
      return { ok: false, error: "record_outside_zone" };
  }
  const result = DnsPurgeResult.parse(
    await deps.runner.run(
      { type: "dns.purge", zoneId, everything: req.everything, urls },
      JOB_TIMEOUT_MS,
    ),
  );
  const at = now();
  await db.dnsChange.create({
    data: {
      zoneId,
      at,
      userId: actor.userId,
      kind: "purge",
      summary: req.everything
        ? "Purged the whole Cloudflare cache"
        : `Purged ${urls.length} URL(s) from the cache`,
      lines: result.ok ? urls.slice(0, 10) : [result.error],
      ok: result.ok,
    },
  });
  await audit(
    db,
    {
      userId: actor.userId,
      action: "dns.cache.purge",
      result: result.ok ? "success" : "failure",
      ip: actor.ip,
      siteIds: await siteIdsFor(db, zone.name),
      meta: { zoneId, zone: zone.name, everything: req.everything, urls: urls.length },
    },
    at,
  );
  return result.ok ? { ok: true } : { ok: false, error: "dns_failed", detail: result.error };
}

const Checklist = z.record(z.string(), z.boolean());

/** Manual steps as ticked; automatic ones from Cloudflare's data. */
export function checklistOf(zone: { checklist: unknown; status: string; nameServers: string[] }) {
  const ticked = Checklist.safeParse(zone.checklist);
  const manual = ticked.success ? ticked.data : {};
  const auto: Partial<Record<MigrationStepKey, boolean>> = {
    zone_active: zone.status === "active",
    // Cloudflare only marks a zone active once the registrar's nameservers point at it.
    nameservers: zone.status === "active" && zone.nameServers.length > 0,
  };
  return MIGRATION_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    auto: s.auto,
    done: s.auto ? Boolean(auto[s.key]) : Boolean(manual[s.key]),
  }));
}

export async function setChecklistItem(
  deps: DnsDeps,
  zoneId: string,
  key: MigrationStepKey,
  done: boolean,
  actor: { userId: string; ip: string | null },
): Promise<boolean> {
  const { db, now } = deps;
  const zone = await db.dnsZone.findUnique({ where: { id: zoneId } });
  if (!zone) return false;
  if (MIGRATION_STEPS.find((s) => s.key === key)?.auto) return false;
  const current = Checklist.safeParse(zone.checklist);
  const next = { ...(current.success ? current.data : {}), [key]: done };
  await db.dnsZone.update({ where: { id: zoneId }, data: { checklist: next } });
  await audit(
    db,
    {
      userId: actor.userId,
      action: "dns.checklist",
      result: "success",
      ip: actor.ip,
      siteIds: await siteIdsFor(db, zone.name),
      meta: { zoneId, zone: zone.name, key, done },
    },
    now(),
  );
  return true;
}
