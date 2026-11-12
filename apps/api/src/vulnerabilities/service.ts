// Vulnerability scanning (Phase 2 step 2, A132). The runner fetches the Wordfence feed; this
// module keeps the records for software we run and matches every environment's last inventory.
import {
  InventoryItem,
  type InstalledSoftware,
  matchVulnerabilities,
  MAX_WANTED_SOFTWARE,
  type Severity,
  SEVERITY_ORDER,
  softwareKey,
  VulnFeedResult,
  VulnFeedStatus,
  type VulnRecord,
  VulnSoftware,
} from "@ulixops/shared";
import { z } from "zod";
import { audit } from "../audit";
import type { Db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";

export const VULN_FEED_STATUS_KEY = "vuln.feed";
/** The runner streams a large feed; give it time (its own fetch timeout is 8 minutes). */
const FEED_TIMEOUT_MS = 10 * 60_000;
const UPSERT_BATCH = 200;

const Items = z.array(InventoryItem);
const StoredSoftware = z.array(VulnSoftware);

export interface VulnDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
}

type StoredStatus = Omit<VulnFeedStatus, "running">;
const EMPTY_STATUS: StoredStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  ok: null,
  error: null,
  records: null,
  total: null,
};

// One sync at a time per API process (the API runs as a single process, A132).
let syncing = false;
export const isSyncing = () => syncing;

export async function readFeedStatus(db: Db): Promise<VulnFeedStatus> {
  const row = await db.setting.findUnique({ where: { key: VULN_FEED_STATUS_KEY } });
  const parsed = VulnFeedStatus.omit({ running: true }).safeParse(row?.value ?? {});
  return { ...(parsed.success ? parsed.data : EMPTY_STATUS), running: syncing };
}

async function writeFeedStatus(db: Db, value: StoredStatus): Promise<void> {
  const json = value as unknown as Prisma.InputJsonObject;
  await db.setting.upsert({
    where: { key: VULN_FEED_STATUS_KEY },
    create: { key: VULN_FEED_STATUS_KEY, value: json },
    update: { value: json },
  });
}

function parseItems(json: Prisma.JsonValue): InventoryItem[] {
  const parsed = Items.safeParse(json);
  return parsed.success ? parsed.data : [];
}

/** Core, plugins and themes from one stored inventory. */
export function installedFrom(inv: {
  wpVersion: string;
  plugins: Prisma.JsonValue;
  themes: Prisma.JsonValue;
}): InstalledSoftware[] {
  return [
    { type: "core" as const, slug: "wordpress", version: inv.wpVersion },
    ...parseItems(inv.plugins).map((p) => ({
      type: "plugin" as const,
      slug: p.name,
      version: p.version,
    })),
    ...parseItems(inv.themes).map((t) => ({
      type: "theme" as const,
      slug: t.name,
      version: t.version,
    })),
  ].filter(
    (item) => item.version.trim() !== "" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.slug),
  );
}

/** Every distinct piece of software installed on an active site's environment. */
export async function wantedSoftware(db: Db) {
  const inventories = await db.siteInventory.findMany({
    where: { environment: { site: { archived: false } } },
    select: { wpVersion: true, plugins: true, themes: true },
  });
  const seen = new Map<string, { type: InstalledSoftware["type"]; slug: string }>();
  for (const inv of inventories)
    for (const item of installedFrom(inv))
      seen.set(softwareKey(item.type, item.slug), {
        type: item.type,
        slug: item.slug.toLowerCase(),
      });
  return [...seen.values()].slice(0, MAX_WANTED_SOFTWARE);
}

async function storeRecords(db: Db, records: VulnRecord[], at: Date): Promise<void> {
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    await db.$transaction(
      records.slice(i, i + UPSERT_BATCH).map((r) => {
        const data = {
          title: r.title,
          severity: r.severity,
          cvssScore: r.cvssScore,
          cve: r.cve,
          reference: r.reference,
          publishedAt: r.publishedAt ? new Date(r.publishedAt) : null,
          software: r.software as unknown as Prisma.InputJsonArray,
          softwareKeys: r.software.map((s) => softwareKey(s.type, s.slug)),
          syncedAt: at,
        };
        return db.vulnerability.upsert({
          where: { id: r.id },
          create: { id: r.id, ...data },
          update: data,
        });
      }),
    );
  }
}

export interface NewFinding {
  siteId: string;
  siteName: string;
  environment: "PRODUCTION" | "STAGING";
  slug: string;
  type: string;
  installedVersion: string;
  fixedIn: string | null;
  title: string;
  severity: Severity;
}

/**
 * Re-matches one environment's last inventory against the stored records. Opens new findings,
 * refreshes ones still affected, resolves ones that no longer are. Returns the newly opened.
 */
export async function rematchEnvironment(
  db: Db,
  environmentId: string,
  at: Date,
): Promise<NewFinding[]> {
  const env = await db.siteEnvironment.findUnique({
    where: { id: environmentId },
    include: { inventory: true, site: { select: { id: true, name: true, archived: true } } },
  });
  if (!env) return [];
  const installed = env.inventory && !env.site.archived ? installedFrom(env.inventory) : [];
  const keys = [...new Set(installed.map((i) => softwareKey(i.type, i.slug)))];
  const rows = keys.length
    ? await db.vulnerability.findMany({ where: { softwareKeys: { hasSome: keys } } })
    : [];
  const records = new Map<string, (typeof rows)[number]>();
  const parsed: VulnRecord[] = [];
  for (const row of rows) {
    const software = StoredSoftware.safeParse(row.software);
    if (!software.success) continue;
    records.set(row.id, row);
    parsed.push({
      id: row.id,
      title: row.title,
      severity: row.severity as Severity,
      cvssScore: row.cvssScore,
      cve: row.cve,
      reference: row.reference,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      software: software.data,
    });
  }
  const matches = matchVulnerabilities(installed, parsed);

  const existing = await db.vulnerabilityFinding.findMany({ where: { environmentId } });
  const key = (vulnerabilityId: string, type: string, slug: string) =>
    `${vulnerabilityId}|${type}|${slug}`;
  const byKey = new Map(existing.map((f) => [key(f.vulnerabilityId, f.softwareType, f.slug), f]));
  const opened: NewFinding[] = [];
  const stillOpen = new Set<string>();

  for (const match of matches) {
    const k = key(match.vulnerabilityId, match.type, match.slug);
    stillOpen.add(k);
    const found = byKey.get(k);
    const data = {
      installedVersion: match.installedVersion.slice(0, 64),
      fixedIn: match.fixedIn,
      lastSeenAt: at,
      resolvedAt: null,
    };
    if (found) {
      await db.vulnerabilityFinding.update({ where: { id: found.id }, data });
    } else {
      await db.vulnerabilityFinding.create({
        data: {
          environmentId,
          vulnerabilityId: match.vulnerabilityId,
          softwareType: match.type,
          slug: match.slug,
          firstSeenAt: at,
          ...data,
        },
      });
    }
    // A resolved finding that is affected again counts as new.
    if (!found || found.resolvedAt) {
      const record = records.get(match.vulnerabilityId);
      opened.push({
        siteId: env.site.id,
        siteName: env.site.name,
        environment: env.kind,
        slug: match.slug,
        type: match.type,
        installedVersion: match.installedVersion,
        fixedIn: match.fixedIn,
        title: record?.title ?? match.vulnerabilityId,
        severity: (record?.severity as Severity | undefined) ?? "unknown",
      });
    }
  }

  const toResolve = existing
    .filter(
      (f) =>
        f.resolvedAt === null && !stillOpen.has(key(f.vulnerabilityId, f.softwareType, f.slug)),
    )
    .map((f) => f.id);
  if (toResolve.length)
    await db.vulnerabilityFinding.updateMany({
      where: { id: { in: toResolve } },
      data: { resolvedAt: at },
    });
  return opened;
}

/** Re-matches every environment that has an inventory. */
export async function rematchAll(db: Db, at: Date): Promise<NewFinding[]> {
  const envs = await db.siteEnvironment.findMany({ select: { id: true } });
  const opened: NewFinding[] = [];
  for (const env of envs) opened.push(...(await rematchEnvironment(db, env.id, at)));
  return opened;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unrated",
};

/** One notification for a batch of new findings, worst first (A132). */
export async function notifyNewFindings(
  notifier: SecurityNotifier,
  opened: NewFinding[],
): Promise<void> {
  if (opened.length === 0 || !notifier.notify) return;
  const sorted = [...opened].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const worst = sorted[0]?.severity ?? "unknown";
  const sites = new Set(opened.map((f) => f.siteId));
  const lines = sorted.slice(0, 10).map((f) => {
    const fix = f.fixedIn ? `fixed in ${f.fixedIn}` : "no fix yet";
    const env = f.environment === "STAGING" ? " (staging)" : "";
    return `${SEVERITY_LABEL[f.severity]}: ${f.siteName}${env} · ${f.slug} ${f.installedVersion} — ${f.title} (${fix})`;
  });
  if (sorted.length > 10) lines.push(`…and ${sorted.length - 10} more on the Security page.`);
  await notifier.notify({
    kind: "vulnerability.found",
    title: `${opened.length} new vulnerabilit${opened.length === 1 ? "y" : "ies"} on ${sites.size} site${sites.size === 1 ? "" : "s"}`,
    body: lines.join("\n"),
    severity: worst === "critical" || worst === "high" ? "critical" : "warning",
    siteIds: [...sites],
  });
}

/** Re-matches one environment after its inventory changed, and alerts on new findings. */
export async function afterInventoryChange(
  deps: { db: Db; now: () => Date; notifier: SecurityNotifier },
  environmentId: string,
): Promise<void> {
  try {
    const opened = await rematchEnvironment(deps.db, environmentId, deps.now());
    await notifyNewFindings(deps.notifier, opened);
  } catch (error) {
    // Matching must never fail the inventory refresh that triggered it.
    console.error(
      JSON.stringify({
        event: "vuln_rematch_failed",
        environmentId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export type SyncOutcome =
  | { ok: true; records: number; total: number; opened: number }
  | { ok: false; error: string }
  | { ok: false; error: "already_running" };

/**
 * Pull the feed through the runner, store the records, re-match everything, alert on new
 * findings, and audit the run. `userId` is null for the daily schedule.
 */
export async function syncVulnerabilities(
  deps: VulnDeps,
  actor: { userId: string | null; ip: string | null },
): Promise<SyncOutcome> {
  if (syncing) return { ok: false, error: "already_running" };
  syncing = true;
  const started = deps.now();
  const { running: _running, ...previous } = await readFeedStatus(deps.db).catch(() => ({
    ...EMPTY_STATUS,
    running: true,
  }));
  const fail = async (error: string): Promise<SyncOutcome> => {
    await writeFeedStatus(deps.db, {
      ...previous,
      lastAttemptAt: started.toISOString(),
      ok: false,
      error,
    });
    await audit(
      deps.db,
      {
        userId: actor.userId,
        action: "vulnerabilities.sync",
        result: "failure",
        ip: actor.ip,
        meta: { error, scheduled: actor.userId === null },
      },
      deps.now(),
    );
    return { ok: false, error };
  };
  try {
    const wanted = await wantedSoftware(deps.db);
    if (wanted.length === 0) return await fail("No site has an inventory yet. Refresh one first.");

    let raw: unknown;
    try {
      raw = await deps.runner.run({ type: "vuln.feed", wanted }, FEED_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof RunnerUnavailableError)
        return await fail("The runner did not answer in time.");
      if (error instanceof RunnerJobFailedError) return await fail(error.message);
      throw error;
    }
    const result = VulnFeedResult.safeParse(raw);
    if (!result.success) return await fail("The runner returned an unexpected answer.");
    if (!result.data.ok) return await fail(result.data.detail);

    const at = deps.now();
    await storeRecords(deps.db, result.data.records, at);
    const opened = await rematchAll(deps.db, at);
    await writeFeedStatus(deps.db, {
      lastAttemptAt: started.toISOString(),
      lastSuccessAt: at.toISOString(),
      ok: true,
      error: null,
      records: result.data.records.length,
      total: result.data.total,
    });
    await audit(
      deps.db,
      {
        userId: actor.userId,
        action: "vulnerabilities.sync",
        result: "success",
        ip: actor.ip,
        siteIds: [...new Set(opened.map((f) => f.siteId))],
        meta: {
          records: result.data.records.length,
          total: result.data.total,
          newFindings: opened.length,
          scheduled: actor.userId === null,
        },
      },
      deps.now(),
    );
    await notifyNewFindings(deps.notifier, opened);
    return {
      ok: true,
      records: result.data.records.length,
      total: result.data.total,
      opened: opened.length,
    };
  } finally {
    syncing = false;
  }
}
