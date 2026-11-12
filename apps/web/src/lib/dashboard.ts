// Pure aggregators for the home Dashboard (A171): ops health, uptime, security.
import {
  type ErrorLogOverview,
  type ExpiryOverview,
  type IntegrityOverview,
  type MalwareOverview,
  phpNeedsUpgrade,
  SEVERITY_ORDER,
  type Severity,
  type UptimeOverview,
  type UptimeStateName,
  type VulnFindingList,
  type VulnFindingView,
} from "@ulixops/shared";
import type { z } from "zod";
import { SiteList } from "@ulixops/shared";

type Sites = z.infer<typeof SiteList>;

export type StatTone = "neutral" | "ok" | "warn" | "bad";

export type ExpiryBucket = "ok" | "soon30" | "soon7" | "broken";

export interface AttentionItem {
  id: string;
  reason: string;
  href: string;
  tone: StatTone;
}

/** Plugin/theme/core updates on production from each site's last inventory. */
export function updatesPending(sites: Sites): number | null {
  const read = sites.sites
    .map((site) => site.environments.find((e) => e.kind === "PRODUCTION")?.inventory)
    .filter((inv) => inv != null);
  if (read.length === 0) return null;
  return read.reduce(
    (sum, inv) => sum + inv.pluginUpdates + inv.themeUpdates + (inv.coreUpdateVersion ? 1 : 0),
    0,
  );
}

/** Production environments whose PHP is end of life or ending soon. */
export function outdatedPhpCount(sites: Sites): number | null {
  const versions = sites.sites
    .map((site) => site.environments.find((e) => e.kind === "PRODUCTION")?.phpVersion)
    .filter((v) => v != null);
  if (versions.length === 0) return null;
  return versions.filter((v) => phpNeedsUpgrade(v)).length;
}

export function outdatedPhpSites(sites: Sites): { siteId: string; siteName: string }[] {
  return sites.sites
    .filter((site) => {
      const v = site.environments.find((e) => e.kind === "PRODUCTION")?.phpVersion;
      return v != null && phpNeedsUpgrade(v);
    })
    .map((s) => ({ siteId: s.id, siteName: s.name }));
}

export function countUptimeStates(overview: UptimeOverview): Record<UptimeStateName, number> {
  const counts: Record<UptimeStateName, number> = { up: 0, down: 0, paused: 0, unknown: 0 };
  for (const s of overview.sites) counts[s.state] += 1;
  return counts;
}

/** Average of known 24h uptime percents; null when none. */
export function avgUptimePercent24h(overview: UptimeOverview): number | null {
  const vals = overview.sites.map((s) => s.day.percent).filter((p): p is number => p != null);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

export function downSites(overview: UptimeOverview): { siteId: string; siteName: string }[] {
  return overview.sites
    .filter((s) => s.state === "down")
    .map((s) => ({ siteId: s.siteId, siteName: s.siteName }));
}

/**
 * Bucket SSL certs and domains: broken (invalid/expired/error) → ≤7d → ≤30d → ok.
 * Production-ish: all certs in the overview; domains are account-level.
 */
export function bucketExpiry(overview: ExpiryOverview): Record<ExpiryBucket, number> {
  const buckets: Record<ExpiryBucket, number> = { ok: 0, soon30: 0, soon7: 0, broken: 0 };
  const place = (ok: boolean, daysLeft: number | null) => {
    if (!ok || (daysLeft !== null && daysLeft < 0)) {
      buckets.broken += 1;
      return;
    }
    if (daysLeft === null) {
      buckets.ok += 1;
      return;
    }
    if (daysLeft <= 7) buckets.soon7 += 1;
    else if (daysLeft <= 30) buckets.soon30 += 1;
    else buckets.ok += 1;
  };
  for (const c of overview.certificates) {
    if (!c.https) {
      buckets.broken += 1;
      continue;
    }
    place(c.ok, c.daysLeft);
  }
  for (const d of overview.domains) {
    const ok = d.status !== "error" && (d.daysLeft === null || d.daysLeft >= 0);
    place(ok, d.daysLeft);
  }
  return buckets;
}

/** Certificates or domains with ≤7 days left or broken. */
export function urgentExpiry(
  overview: ExpiryOverview,
): { label: string; href: string; tone: StatTone }[] {
  const out: { label: string; href: string; tone: StatTone }[] = [];
  for (const c of overview.certificates) {
    const broken = !c.https || !c.ok || (c.daysLeft !== null && c.daysLeft < 0);
    const urgent = c.daysLeft !== null && c.daysLeft <= 7;
    if (!broken && !urgent) continue;
    out.push({
      label: broken
        ? `SSL broken: ${c.siteName} (${c.host})`
        : `SSL ≤${c.daysLeft}d: ${c.siteName} (${c.host})`,
      href: `/sites/${c.siteId}/monitoring`,
      tone: broken || (c.daysLeft !== null && c.daysLeft <= 0) ? "bad" : "warn",
    });
  }
  for (const d of overview.domains) {
    const broken = d.status === "error" || (d.daysLeft !== null && d.daysLeft < 0);
    const urgent = d.daysLeft !== null && d.daysLeft <= 7;
    if (!broken && !urgent) continue;
    const site = d.sites[0];
    out.push({
      label: broken ? `Domain issue: ${d.domain}` : `Domain ≤${d.daysLeft}d: ${d.domain}`,
      href: site ? `/sites/${site.id}/monitoring` : "/monitoring/ssl",
      tone: broken || (d.daysLeft !== null && d.daysLeft <= 0) ? "bad" : "warn",
    });
  }
  return out;
}

export function vulnBySeverity(list: VulnFindingList): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of list.findings) {
    if (f.resolvedAt) continue;
    counts[f.severity] += 1;
  }
  return counts;
}

export function openVulns(list: VulnFindingList): VulnFindingView[] {
  return list.findings.filter((f) => !f.resolvedAt);
}

/** Worst open findings first (severity then CVSS). */
export function worstOpenVulns(list: VulnFindingList, limit = 5): VulnFindingView[] {
  const rank = (s: Severity) => SEVERITY_ORDER.indexOf(s);
  return [...openVulns(list)]
    .sort((a, b) => rank(a.severity) - rank(b.severity) || (b.cvssScore ?? 0) - (a.cvssScore ?? 0))
    .slice(0, limit);
}

export function infectedSites(overview: MalwareOverview): { siteId: string; siteName: string }[] {
  return overview.sites
    .filter((s) => s.last?.status === "INFECTED")
    .map((s) => ({ siteId: s.siteId, siteName: s.siteName }));
}

export function integrityChangedSites(
  overview: IntegrityOverview,
): { siteId: string; siteName: string }[] {
  return overview.sites
    .filter((s) => s.last?.status === "CHANGED")
    .map((s) => ({ siteId: s.siteId, siteName: s.siteName }));
}

export function phpFatalSites(
  overview: ErrorLogOverview,
): { siteId: string; siteName: string; fatal24h: number; warnings24h: number }[] {
  return overview.rows
    .filter((r) => r.environment === "PRODUCTION" && (r.fatal24h > 0 || r.warnings24h > 0))
    .sort((a, b) => b.fatal24h - a.fatal24h || b.warnings24h - a.warnings24h)
    .map((r) => ({
      siteId: r.siteId,
      siteName: r.siteName,
      fatal24h: r.fatal24h,
      warnings24h: r.warnings24h,
    }));
}

/** Composite “needs attention” list, capped, worst first. */
export function attentionItems(input: {
  uptime: UptimeOverview | null;
  expiry: ExpiryOverview | null;
  vulns: VulnFindingList | null;
  malware: MalwareOverview | null;
  integrity: IntegrityOverview | null;
  sites: Sites | null;
  limit?: number;
}): AttentionItem[] {
  const limit = input.limit ?? 10;
  const items: AttentionItem[] = [];

  if (input.uptime) {
    for (const s of downSites(input.uptime)) {
      items.push({
        id: `down:${s.siteId}`,
        reason: `${s.siteName} is down`,
        href: `/sites/${s.siteId}/monitoring`,
        tone: "bad",
      });
    }
  }
  if (input.malware) {
    for (const s of infectedSites(input.malware)) {
      items.push({
        id: `malware:${s.siteId}`,
        reason: `${s.siteName}: malware findings`,
        href: `/sites/${s.siteId}/security`,
        tone: "bad",
      });
    }
  }
  if (input.integrity) {
    for (const s of integrityChangedSites(input.integrity)) {
      items.push({
        id: `integrity:${s.siteId}`,
        reason: `${s.siteName}: file integrity changed`,
        href: `/security/integrity`,
        tone: "warn",
      });
    }
  }
  if (input.vulns) {
    for (const f of worstOpenVulns(input.vulns, 5).filter((v) => v.severity === "critical")) {
      items.push({
        id: `vuln:${f.id}`,
        reason: `Critical vuln: ${f.siteName} · ${f.slug}`,
        href: `/security`,
        tone: "bad",
      });
    }
  }
  if (input.expiry) {
    for (const e of urgentExpiry(input.expiry)) {
      items.push({
        id: `expiry:${e.label}`,
        reason: e.label,
        href: e.href,
        tone: e.tone,
      });
    }
  }
  if (input.sites) {
    for (const s of outdatedPhpSites(input.sites).slice(0, 5)) {
      items.push({
        id: `php:${s.siteId}`,
        reason: `${s.siteName}: outdated PHP`,
        href: `/sites/${s.siteId}`,
        tone: "warn",
      });
    }
  }

  const toneRank = (t: StatTone) => (t === "bad" ? 0 : t === "warn" ? 1 : 2);
  return items.sort((a, b) => toneRank(a.tone) - toneRank(b.tone)).slice(0, limit);
}

export function toneForCount(n: number | null, { warnAt = 1, badAt = 1 } = {}): StatTone {
  if (n === null) return "neutral";
  if (n === 0) return "ok";
  if (n >= badAt) return "bad";
  if (n >= warnAt) return "warn";
  return "neutral";
}

/** Count items by a label key, sorted descending. */
export function countByLabel<T>(
  items: T[],
  labelOf: (item: T) => string,
  limit = 6,
): { key: string; label: string; count: number }[] {
  const map = new Map<string, number>();
  for (const item of items) {
    const label = labelOf(item);
    map.set(label, (map.get(label) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([label, count]) => ({ key: label, label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** First segment of an audit action (`site.errorlog.read` → `site`). */
export function auditCategory(action: string): string {
  const i = action.indexOf(".");
  return i > 0 ? action.slice(0, i) : action;
}
