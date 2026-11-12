// SSL certificate and domain registration expiry (Phase 3 step 1, A148). The runner reads each
// site's certificate (TLS handshake) and the domain's expiry (registry RDAP); this module stores
// the latest result, alerts once per threshold (30/14/7/3/1 days, expired), and checks every
// site daily. Read-only on the sites, so the daily run is not an approval-gated bulk action.
import { startDueAutoUpdates } from "../autoupdates/service";
import { dnsSyncDue, readDnsStatus, syncDns } from "../dns/service";
import { collectDueErrorLogs } from "../errorlog/service";
import {
  alertLevel,
  type CertificateView,
  daysLeft,
  type DomainCheckResult,
  type DomainView,
  type ExpiryCheckRequest,
  expiryAlertDue,
  ExpiryJobResult,
  ExpiryRunStatus,
  expiryTargetOf,
  isProviderHost,
  type SslCheckResult,
} from "@ulixops/shared";
import { audit } from "../audit";
import type { Db } from "../db";
import type {
  DomainRegistration,
  Prisma,
  SiteEnvironment,
  SslCertificate,
} from "../generated/prisma/client";
import type { SecurityNotifier } from "../notify";
import { type RunnerClient, RunnerJobFailedError, RunnerUnavailableError } from "../runner/client";

const HOUR = 60 * 60_000;
export const EXPIRY_CHECK_EVERY_MS = 24 * HOUR;
const RETRY_AFTER_FAILURE_MS = 6 * HOUR;
const STATUS_KEY = "monitor.expiry.status";
/** Every site: up to 200 hosts, 4 at a time, ~25 s worst case each. */
const FULL_TIMEOUT_MS = 10 * 60_000;
const SITE_TIMEOUT_MS = 2 * 60_000;

export interface ExpiryDeps {
  db: Db;
  now: () => Date;
  runner: RunnerClient;
  notifier: SecurityNotifier;
}

type Actor = { userId: string | null; ip: string | null };
type EnvRow = SiteEnvironment & {
  site: { id: string; name: string };
  sslCertificate: SslCertificate | null;
};

let running = false;
let lastRun: Promise<unknown> = Promise.resolve();
/** The most recent background run (tests wait on it). */
export const lastExpiryRun = () => lastRun;

const StoredStatus = ExpiryRunStatus.omit({ running: true });
type StoredStatus = Omit<ExpiryRunStatus, "running">;
const EMPTY: StoredStatus = { lastAttemptAt: null, lastSuccessAt: null, ok: null, error: null };

export async function readExpiryStatus(db: Db): Promise<ExpiryRunStatus> {
  const row = await db.setting.findUnique({ where: { key: STATUS_KEY } });
  const parsed = StoredStatus.safeParse(row?.value ?? {});
  return { ...(parsed.success ? parsed.data : EMPTY), running };
}

async function writeStatus(db: Db, value: StoredStatus): Promise<void> {
  const json = value as unknown as Prisma.InputJsonObject;
  await db.setting.upsert({
    where: { key: STATUS_KEY },
    create: { key: STATUS_KEY, value: json },
    update: { value: json },
  });
}

/** True when the daily run should start now. */
export function expiryRunDue(status: StoredStatus, at: Date): boolean {
  const t = at.getTime();
  const success = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : null;
  if (success !== null && t - success < EXPIRY_CHECK_EVERY_MS) return false;
  const attempt = status.lastAttemptAt ? Date.parse(status.lastAttemptAt) : null;
  if (attempt !== null && status.ok === false && t - attempt < RETRY_AFTER_FAILURE_MS) return false;
  return true;
}

/** What to ask the runner for each environment: https URLs get a certificate check, production
 * hosts (not WP Engine's own names) a domain lookup. Dev hosts are skipped. */
export function planChecks(envs: { kind: string; url: string }[]): ExpiryCheckRequest[] {
  const byHost = new Map<string, ExpiryCheckRequest>();
  for (const env of envs) {
    const target = expiryTargetOf(env.url);
    if (!target) continue;
    const domain = env.kind === "PRODUCTION" && !isProviderHost(target.host);
    const prev = byHost.get(target.host);
    byHost.set(target.host, {
      host: target.host,
      port: prev?.ssl ? prev.port : target.port,
      ssl: (prev?.ssl ?? false) || target.https,
      domain: (prev?.domain ?? false) || domain,
    });
  }
  return [...byHost.values()].filter((c) => c.ssl || c.domain);
}

export type ExpiryStartOutcome = { ok: true } | { ok: false; error: "expiry_running" };

/** Starts a run in the background: every active site, or one (`siteId`). */
export function startExpiryCheck(
  deps: ExpiryDeps,
  actor: Actor,
  siteId?: string,
): ExpiryStartOutcome {
  if (running) return { ok: false, error: "expiry_running" };
  running = true;
  const run = runExpiry(deps, actor, siteId)
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "expiry_check_crashed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    })
    .finally(() => {
      running = false;
    });
  lastRun = run;
  return { ok: true };
}

async function runExpiry(deps: ExpiryDeps, actor: Actor, siteId?: string): Promise<void> {
  const { db, now } = deps;
  const started = now();
  const full = siteId === undefined;
  const envs: EnvRow[] = await db.siteEnvironment.findMany({
    where: { site: { archived: false, ...(siteId ? { id: siteId } : {}) } },
    include: { site: { select: { id: true, name: true } }, sslCertificate: true },
  });
  const previous = full ? await readExpiryStatus(db) : null;
  const siteIds = [...new Set(envs.map((e) => e.site.id))];

  const fail = async (error: string) => {
    if (previous) {
      const { running: _r, ...rest } = previous;
      await writeStatus(db, { ...rest, lastAttemptAt: started.toISOString(), ok: false, error });
    }
    await audit(
      db,
      {
        userId: actor.userId,
        action: "monitor.expiry.check",
        result: "failure",
        ip: actor.ip,
        siteIds,
        meta: { scheduled: actor.userId === null, error: error.slice(0, 300) },
      },
      now(),
    );
  };

  const checks = planChecks(envs);
  let result: ExpiryJobResult = { results: [], durationMs: 0 };
  if (checks.length > 0) {
    let raw: unknown;
    try {
      raw = await deps.runner.run(
        { type: "monitor.expiry", checks },
        full ? FULL_TIMEOUT_MS : SITE_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof RunnerUnavailableError)
        return fail("The runner did not answer in time.");
      if (error instanceof RunnerJobFailedError) return fail(error.message);
      throw error;
    }
    const parsed = ExpiryJobResult.safeParse(raw);
    if (!parsed.success) return fail("The runner returned an unexpected answer.");
    result = parsed.data;
  }

  const byHost = new Map(result.results.map((r) => [r.host, r]));
  const at = now();
  const summary = { certificates: 0, failing: 0, expiringSoon: 0, domains: 0, alerts: 0 };

  // Domains first (one row per registered domain, with every site on it), so certificates can
  // point at them.
  const domainOf = new Map<string, string | null>();
  const byDomain = new Map<string, { result: DomainCheckResult; siteIds: Set<string> }>();
  for (const r of result.results) {
    if (!r.domain) continue;
    const name = domainNameFor(r.domain, r.host, envs);
    domainOf.set(r.host, name);
    if (!name) continue;
    const entry = byDomain.get(name) ?? { result: r.domain, siteIds: new Set<string>() };
    // A lookup that worked beats one that failed for another host of the same domain.
    if (entry.result.status === "error" && r.domain.status !== "error") entry.result = r.domain;
    for (const env of envs)
      if (env.kind === "PRODUCTION" && expiryTargetOf(env.url)?.host === r.host)
        entry.siteIds.add(env.site.id);
    byDomain.set(name, entry);
  }
  for (const [name, { result: lookup, siteIds: ids }] of byDomain)
    await storeDomain(deps, name, lookup, at, [...ids], summary);

  for (const env of envs) {
    const target = expiryTargetOf(env.url);
    if (!target) continue;
    const r = byHost.get(target.host);
    const domain = domainOf.has(target.host)
      ? (domainOf.get(target.host) ?? null)
      : (env.sslCertificate?.domain ?? null);
    await storeCertificate(
      deps,
      env,
      target,
      target.https ? (r?.ssl ?? null) : null,
      env.kind === "PRODUCTION" ? domain : null,
      at,
      summary,
    );
  }

  if (previous)
    await writeStatus(db, {
      lastAttemptAt: started.toISOString(),
      lastSuccessAt: at.toISOString(),
      ok: true,
      error: null,
    });
  await audit(
    db,
    {
      userId: actor.userId,
      action: "monitor.expiry.check",
      result: "success",
      ip: actor.ip,
      siteIds,
      meta: { scheduled: actor.userId === null, hosts: checks.length, ...summary },
    },
    now(),
  );
}

// ---- Certificates --------------------------------------------------------------------------

async function storeCertificate(
  deps: ExpiryDeps,
  env: EnvRow,
  target: { host: string; https: boolean },
  ssl: SslCheckResult | null,
  domain: string | null,
  at: Date,
  summary: { certificates: number; failing: number; expiringSoon: number; alerts: number },
): Promise<void> {
  const { db } = deps;
  const prev = env.sslCertificate;
  if (target.https && !ssl) return; // nothing came back for this host; keep the last result
  const validTo = ssl?.validTo ? new Date(ssl.validTo) : null;
  const label = `${env.site.name}${env.kind === "STAGING" ? " (staging)" : ""}`;
  let alertedDays = prev?.alertedDays ?? null;
  let alertedValidTo = prev?.alertedValidTo ?? null;
  let alertedInvalid = prev?.alertedInvalid ?? false;
  summary.certificates++;

  if (ssl && validTo) {
    const days = daysLeft(validTo, at);
    const level = alertLevel(days);
    if (level !== null) summary.expiringSoon++;
    if (expiryAlertDue(level, { level: alertedDays, forDate: alertedValidTo }, validTo)) {
      await alert(deps, summary, {
        kind: "ssl.expiring",
        title:
          days < 0
            ? `SSL certificate expired: ${label}`
            : `SSL certificate expires in ${days} day${days === 1 ? "" : "s"}: ${label}`,
        body: `${target.host} · valid until ${validTo.toISOString().slice(0, 10)}${ssl.issuer ? ` · issued by ${ssl.issuer}` : ""}. ${days < 0 ? "Visitors see a security warning." : "Check that automatic renewal is working at the host."}`,
        severity: days <= 7 ? "critical" : "warning",
        siteIds: [env.site.id],
        scope: env.id,
      });
      alertedDays = level;
      alertedValidTo = validTo;
    } else if (level === null) {
      alertedDays = null;
      alertedValidTo = null;
    }
    if (level === null)
      await deps.notifier.observe?.({
        kind: "ssl.expiring",
        siteIds: [env.site.id],
        scope: env.id,
        ok: true,
        note: `The certificate was renewed: valid until ${validTo.toISOString().slice(0, 10)}`,
      });
  }

  if (ssl && !ssl.ok) {
    summary.failing++;
    const expired = validTo !== null && validTo.getTime() < at.getTime();
    // Unreachable needs two checks in a row (no alert for one blip); certificate problems alert
    // straight away. Expiry has its own alert above.
    const unreachable = ssl.validTo === null;
    const wasUnreachable = prev !== null && prev.https && !prev.ok && prev.validTo === null;
    if (!expired && !alertedInvalid && (!unreachable || wasUnreachable)) {
      await alert(deps, summary, {
        kind: "ssl.invalid",
        title: `SSL problem on ${label}`,
        body: `${target.host}: ${ssl.error ?? "the certificate isn't valid"}`,
        severity: "critical",
        siteIds: [env.site.id],
        scope: env.id,
      });
      alertedInvalid = true;
    } else if (alertedInvalid) {
      await deps.notifier.observe?.({
        kind: "ssl.invalid",
        siteIds: [env.site.id],
        scope: env.id,
        ok: false,
        note: `A later check still failed: ${ssl.error ?? "the certificate isn't valid"}`,
      });
    }
  } else if (ssl?.ok) {
    alertedInvalid = false;
    await deps.notifier.observe?.({
      kind: "ssl.invalid",
      siteIds: [env.site.id],
      scope: env.id,
      ok: true,
      note: "A later check found a valid certificate",
    });
  }

  const data = {
    host: target.host,
    https: target.https,
    checkedAt: at,
    ok: ssl?.ok ?? false,
    validFrom: ssl?.validFrom ? new Date(ssl.validFrom) : null,
    validTo,
    issuer: ssl?.issuer ?? null,
    subject: ssl?.subject ?? null,
    altNames: ssl?.altNames ?? [],
    error: ssl
      ? ssl.error
      : "The site URL uses plain http://, so visitors get no certificate. Change it to https:// if the site has one.",
    domain,
    alertedDays,
    alertedValidTo,
    alertedInvalid,
  };
  await db.sslCertificate.upsert({
    where: { environmentId: env.id },
    create: { environmentId: env.id, ...data },
    update: data,
  });
}

// ---- Domains -------------------------------------------------------------------------------

/** The registered domain a lookup is about; a failed lookup falls back to the last one known. */
function domainNameFor(result: DomainCheckResult, host: string, envs: EnvRow[]): string | null {
  return (
    result.domain ??
    envs.find((e) => expiryTargetOf(e.url)?.host === host && e.sslCertificate?.domain)
      ?.sslCertificate?.domain ??
    null
  );
}

async function storeDomain(
  deps: ExpiryDeps,
  name: string,
  result: DomainCheckResult,
  at: Date,
  siteIds: string[],
  summary: { domains: number; alerts: number },
): Promise<void> {
  const { db } = deps;
  summary.domains++;
  const prev = await db.domainRegistration.findUnique({ where: { domain: name } });
  // A failed lookup keeps the date we already had.
  const keepOld = result.status === "error";
  const data = {
    status: keepOld && prev?.expiresAt ? prev.status : result.status,
    checkedAt: at,
    expiresAt: keepOld
      ? (prev?.expiresAt ?? null)
      : result.expiresAt
        ? new Date(result.expiresAt)
        : null,
    registrar: result.registrar ?? prev?.registrar ?? null,
    error: result.error,
  };
  const row = await db.domainRegistration.upsert({
    where: { domain: name },
    create: { domain: name, ...data },
    update: data,
  });
  await alertDomain(deps, row, at, summary, siteIds);
}

/** Registry date wins; the manual date covers registries that publish none. */
export function effectiveExpiry(row: Pick<DomainRegistration, "expiresAt" | "manualExpiresAt">) {
  return row.expiresAt ?? row.manualExpiresAt ?? null;
}

async function alertDomain(
  deps: ExpiryDeps,
  row: DomainRegistration,
  at: Date,
  summary: { alerts: number },
  siteIds: string[],
): Promise<void> {
  const expires = effectiveExpiry(row);
  if (!expires) return;
  const days = daysLeft(expires, at);
  const level = alertLevel(days);
  let update: { alertedDays: number | null; alertedExpiresAt: Date | null } | null = null;
  if (expiryAlertDue(level, { level: row.alertedDays, forDate: row.alertedExpiresAt }, expires)) {
    await alert(deps, summary, {
      kind: "domain.expiring",
      title:
        days < 0
          ? `Domain expired: ${row.domain}`
          : `Domain ${row.domain} expires in ${days} day${days === 1 ? "" : "s"}`,
      body: `Registration ends ${expires.toISOString().slice(0, 10)}${row.registrar ? ` (registrar: ${row.registrar})` : ""}. ${days < 0 ? "The site and email stop working once the registrar releases it." : "Renew it at the registrar, or check auto-renew and the card on file."}`,
      severity: days <= 7 ? "critical" : "warning",
      siteIds,
      scope: row.domain,
    });
    update = { alertedDays: level, alertedExpiresAt: expires };
  } else if (level === null && (row.alertedDays !== null || row.alertedExpiresAt !== null)) {
    update = { alertedDays: null, alertedExpiresAt: null };
  }
  if (level === null)
    await deps.notifier.observe?.({
      kind: "domain.expiring",
      scope: row.domain,
      ok: true,
      note: `The domain was renewed: registered until ${expires.toISOString().slice(0, 10)}`,
    });
  if (update)
    await deps.db.domainRegistration.update({ where: { domain: row.domain }, data: update });
}

async function sitesOfDomain(db: Db, domain: string): Promise<{ id: string; name: string }[]> {
  const rows = await db.sslCertificate.findMany({
    where: { domain, environment: { site: { archived: false } } },
    select: { environment: { select: { site: { select: { id: true, name: true } } } } },
  });
  const map = new Map(rows.map((r) => [r.environment.site.id, r.environment.site]));
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Admin-entered expiry for a domain whose registry publishes none; null clears it. */
export async function setManualDomainExpiry(
  deps: ExpiryDeps,
  domain: string,
  date: string | null,
  actor: { userId: string; ip: string | null },
): Promise<{ ok: boolean }> {
  const { db, now } = deps;
  const row = await db.domainRegistration.findUnique({ where: { domain } });
  if (!row) return { ok: false };
  // End of that day (UTC): registrars renew or release during the day it's due.
  const manualExpiresAt = date ? new Date(`${date}T23:59:59.000Z`) : null;
  const updated = await db.domainRegistration.update({
    where: { domain },
    data: { manualExpiresAt, manualSetById: manualExpiresAt ? actor.userId : null },
  });
  const sites = await sitesOfDomain(db, domain);
  await audit(
    db,
    {
      userId: actor.userId,
      action: "monitor.domain.manual_expiry",
      result: "success",
      ip: actor.ip,
      siteIds: sites.map((s) => s.id),
      meta: { domain, expiresAt: date },
    },
    now(),
  );
  await alertDomain(
    deps,
    updated,
    now(),
    { alerts: 0 },
    sites.map((s) => s.id),
  );
  return { ok: true };
}

async function alert(
  deps: ExpiryDeps,
  summary: { alerts: number },
  input: Parameters<NonNullable<SecurityNotifier["notify"]>>[0],
): Promise<void> {
  summary.alerts++;
  await deps.notifier.notify?.(input);
}

// ---- Views ---------------------------------------------------------------------------------

export function certificateView(
  env: SiteEnvironment & { site: { id: string; name: string } },
  row: SslCertificate,
  at: Date,
): CertificateView {
  return {
    siteId: env.site.id,
    siteName: env.site.name,
    environment: env.kind,
    host: row.host,
    https: row.https,
    checkedAt: row.checkedAt.toISOString(),
    ok: row.ok,
    validFrom: row.validFrom?.toISOString() ?? null,
    validTo: row.validTo?.toISOString() ?? null,
    daysLeft: row.validTo ? daysLeft(row.validTo, at) : null,
    issuer: row.issuer,
    altNames: row.altNames,
    error: row.error,
    domain: row.domain,
  };
}

export async function domainViews(
  db: Db,
  certificates: CertificateView[],
  at: Date,
): Promise<DomainView[]> {
  const sitesBy = new Map<string, Map<string, string>>();
  for (const c of certificates) {
    if (!c.domain) continue;
    const sites = sitesBy.get(c.domain) ?? new Map<string, string>();
    sites.set(c.siteId, c.siteName);
    sitesBy.set(c.domain, sites);
  }
  const rows = await db.domainRegistration.findMany({
    where: { domain: { in: [...sitesBy.keys()] } },
    orderBy: { domain: "asc" },
  });
  return rows.map((row) => {
    const expires = effectiveExpiry(row);
    return {
      domain: row.domain,
      sites: [...(sitesBy.get(row.domain) ?? new Map<string, string>())]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      status: row.status as DomainView["status"],
      checkedAt: row.checkedAt?.toISOString() ?? null,
      expiresAt: expires?.toISOString() ?? null,
      manual: !row.expiresAt && Boolean(row.manualExpiresAt),
      daysLeft: expires ? daysLeft(expires, at) : null,
      registrar: row.registrar,
      error: row.error,
    };
  });
}

// ---- Daily schedule ------------------------------------------------------------------------

/** Checks hourly (first check after `firstDelayMs`); returns a stop function. */
export function startExpiryScheduler(
  deps: ExpiryDeps,
  opts: { firstDelayMs?: number; intervalMs?: number } = {},
): () => void {
  const tick = async () => {
    // Scheduled updates of sites whose weekly window is open (A162).
    void startDueAutoUpdates(deps).catch(() => undefined);
    // PHP error logs of production sites, every 6 hours (A159).
    void collectDueErrorLogs(deps).catch(() => undefined);
    // Cloudflare DNS change alerts (A156): every zone re-read every 6 hours.
    void readDnsStatus(deps.db)
      .then((dns) =>
        dnsSyncDue(dns, deps.now()) ? syncDns(deps, { userId: null, ip: null }) : null,
      )
      .catch(() => undefined);
    try {
      const status = await readExpiryStatus(deps.db);
      if (status.running || !expiryRunDue(status, deps.now())) return;
      startExpiryCheck(deps, { userId: null, ip: null });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "expiry_schedule_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  const first = setTimeout(() => void tick(), opts.firstDelayMs ?? 3 * 60_000);
  const every = setInterval(() => void tick(), opts.intervalMs ?? HOUR);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
