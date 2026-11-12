// Monitoring (Phase 3): SSL certificate and domain registration expiry (P3-1, A148). The runner
// reads each site's certificate with a TLS handshake and the domain's expiry from the
// registry's RDAP service; nothing runs on the sites.
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();
const Env = z.enum(["PRODUCTION", "STAGING"]);
const DAY_MS = 24 * 60 * 60_000;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Names that never resolve on the public internet (dev containers, RFC 2606 / 6761 names). */
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "test",
  "example",
  "invalid",
  "lan",
  "home.arpa",
];

/** Lower-case DNS name with at least two labels; no IP addresses. */
export const PublicHostname = z
  .string()
  .max(253)
  .regex(HOSTNAME)
  .refine((h) => isPublicHostname(h), "Not a public host name");

export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (!HOSTNAME.test(h)) return false;
  if (/^[\d.]+$/.test(h)) return false;
  return !PRIVATE_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Hosting providers' own domains (WP Engine staging/install names): their registration is the
 * provider's business, so only the certificate is checked for these hosts.
 */
export const PROVIDER_DOMAINS = ["wpengine.com", "wpenginepowered.com"] as const;

export function isProviderHost(host: string): boolean {
  const h = host.toLowerCase();
  return PROVIDER_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Names to ask the registry about, longest first ("www.shop.example.co.uk" → "www.shop…",
 * "shop.example.co.uk", "example.co.uk", "co.uk"). Registries answer 404 for names that are not
 * registered, so the first hit is the registered domain. At most 4, never a bare TLD.
 */
export function domainCandidates(host: string): string[] {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out.slice(-4);
}

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ltd", "plc"]);

/**
 * Best guess at the registered domain when no registry can confirm it (no RDAP service): the
 * last two labels, or three under common second-level names ("example.com.au").
 */
export function guessRegisteredDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const take = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2] ?? "") ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** How a URL is checked: host and TLS port, or null when it isn't a public name. */
export function expiryTargetOf(url: string): { host: string; port: number; https: boolean } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!isPublicHostname(host)) return null;
  const https = parsed.protocol === "https:";
  return { host, port: https && parsed.port ? Number(parsed.port) : 443, https };
}

// ---- Expiry thresholds ---------------------------------------------------------------------

/** Alerts fire once per threshold as the date gets closer; 0 = expired. */
export const EXPIRY_ALERT_DAYS = [30, 14, 7, 3, 1, 0] as const;

/** Whole days left (negative once expired; 0 on the last day). */
export function daysLeft(expiresAt: string | Date, now: Date): number {
  const t = typeof expiresAt === "string" ? Date.parse(expiresAt) : expiresAt.getTime();
  return Math.floor((t - now.getTime()) / DAY_MS);
}

/** The tightest threshold reached, or null when more than 30 days are left. */
export function alertLevel(days: number): number | null {
  if (days < 0) return 0;
  let level: number | null = null;
  for (const t of EXPIRY_ALERT_DAYS) if (days <= t) level = t;
  return level;
}

/**
 * Whether to alert now. `previous` is what was already alerted for the same expiry date; a new
 * date (renewed certificate or domain) starts over.
 */
export function expiryAlertDue(
  level: number | null,
  previous: { level: number | null; forDate: Date | null },
  expiresAt: Date,
): boolean {
  if (level === null) return false;
  if (!previous.forDate || previous.forDate.getTime() !== expiresAt.getTime()) return true;
  return previous.level === null || level < previous.level;
}

export type ExpiryTone = "ok" | "warning" | "critical" | "expired" | "unknown";

/** Badge tone: warning within 30 days, critical within 7. */
export function expiryTone(days: number | null): ExpiryTone {
  if (days === null) return "unknown";
  if (days < 0) return "expired";
  if (days <= 7) return "critical";
  if (days <= 30) return "warning";
  return "ok";
}

// ---- Runner job ------------------------------------------------------------------------------

export const MAX_EXPIRY_HOSTS = 200;

export const ExpiryCheckRequest = z.object({
  host: PublicHostname,
  port: z.number().int().min(1).max(65535),
  /** Read the certificate (https URLs). */
  ssl: z.boolean(),
  /** Look up the registered domain's expiry (production, not a provider host). */
  domain: z.boolean(),
});
export type ExpiryCheckRequest = z.infer<typeof ExpiryCheckRequest>;

export const SslCheckResult = z.object({
  /** Trusted chain, name matches, inside its validity period. */
  ok: z.boolean(),
  validFrom: iso.nullable(),
  validTo: iso.nullable(),
  issuer: z.string().max(300).nullable(),
  subject: z.string().max(300).nullable(),
  altNames: z.array(z.string().max(253)).max(100),
  /** Why it isn't ok (handshake failure, untrusted chain, name mismatch, expired). */
  error: z.string().max(300).nullable(),
});
export type SslCheckResult = z.infer<typeof SslCheckResult>;

export const DomainLookupStatus = z.enum(["found", "unsupported", "not_found", "error"]);
export type DomainLookupStatus = z.infer<typeof DomainLookupStatus>;

export const DomainCheckResult = z.object({
  /** The registered domain (the first candidate the registry knows), when found. */
  domain: PublicHostname.nullable(),
  status: DomainLookupStatus,
  expiresAt: iso.nullable(),
  registrar: z.string().max(200).nullable(),
  error: z.string().max(300).nullable(),
});
export type DomainCheckResult = z.infer<typeof DomainCheckResult>;

export const ExpiryJobResult = z.object({
  results: z
    .array(
      z.object({
        host: PublicHostname,
        ssl: SslCheckResult.nullable(),
        domain: DomainCheckResult.nullable(),
      }),
    )
    .max(MAX_EXPIRY_HOSTS),
  durationMs: z.number(),
});
export type ExpiryJobResult = z.infer<typeof ExpiryJobResult>;

// ---- Views ---------------------------------------------------------------------------------

export const CertificateView = z.object({
  siteId: id,
  siteName: z.string(),
  environment: Env,
  host: z.string(),
  https: z.boolean(),
  checkedAt: iso,
  ok: z.boolean(),
  validFrom: iso.nullable(),
  validTo: iso.nullable(),
  /** Whole days until validTo; null when unknown. */
  daysLeft: z.number().int().nullable(),
  issuer: z.string().nullable(),
  altNames: z.array(z.string()),
  error: z.string().nullable(),
  /** Registered domain this host belongs to (production only). */
  domain: z.string().nullable(),
});
export type CertificateView = z.infer<typeof CertificateView>;

export const DomainView = z.object({
  domain: z.string(),
  sites: z.array(z.object({ id, name: z.string() })),
  status: DomainLookupStatus,
  checkedAt: iso.nullable(),
  /** What the registry says, or the manual date when the registry publishes none. */
  expiresAt: iso.nullable(),
  /** expiresAt came from an Admin, not the registry. */
  manual: z.boolean(),
  daysLeft: z.number().int().nullable(),
  registrar: z.string().nullable(),
  error: z.string().nullable(),
});
export type DomainView = z.infer<typeof DomainView>;

export const ExpiryRunStatus = z.object({
  running: z.boolean(),
  lastAttemptAt: iso.nullable(),
  lastSuccessAt: iso.nullable(),
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type ExpiryRunStatus = z.infer<typeof ExpiryRunStatus>;

export const ExpiryOverview = z.object({
  status: ExpiryRunStatus,
  certificates: z.array(CertificateView),
  domains: z.array(DomainView),
  /** Environments without a public name (dev containers) or not checked yet. */
  unchecked: z.array(
    z.object({ siteId: id, siteName: z.string(), environment: Env, url: z.string() }),
  ),
});
export type ExpiryOverview = z.infer<typeof ExpiryOverview>;

/** One site's certificates and domains (site "Uptime & SSL" tab). */
export const SiteExpiryView = z.object({
  status: ExpiryRunStatus,
  certificates: z.array(CertificateView),
  domains: z.array(DomainView),
});
export type SiteExpiryView = z.infer<typeof SiteExpiryView>;

/** Admin-entered expiry for a domain whose registry has no RDAP service; null clears it. */
export const SetDomainExpiry = z.object({
  expiresAt: z.iso.date().nullable(),
});
export type SetDomainExpiry = z.infer<typeof SetDomainExpiry>;

// ---- Uptime (P3-2, A149) -------------------------------------------------------------------
// Every few minutes the runner fetches each production homepage; two failed checks in a row
// open an incident ("down"), the next good check closes it ("up").

/** How often every monitored site is checked. */
export const UPTIME_INTERVAL_MS = 5 * 60_000;
/** Failed checks in a row before a site counts as down (each check already retries once). */
export const UPTIME_DOWN_AFTER = 2;
/** Probe samples are kept this long (uptime % up to 30 days). */
export const UPTIME_SAMPLE_DAYS = 30;
/** Closed incidents are kept this long. */
export const UPTIME_INCIDENT_DAYS = 365;
export const MAX_UPTIME_PROBES = 500;

const ProbeHost = z
  .string()
  .max(253)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/);

export const UptimeProbe = z.object({
  /** The environment's id, echoed back with the result. */
  id,
  url: z.url({ protocol: /^https?$/ }).max(500),
  /** SSH host, so local test containers' loopback URLs reach the container (A80, A96). */
  sshHost: ProbeHost,
});
export type UptimeProbe = z.infer<typeof UptimeProbe>;

export const UptimeProbeResult = z.object({
  id,
  /** The site answered (any HTTP status below 500) without a PHP / WordPress error page. */
  ok: z.boolean(),
  status: z.number().int().min(100).max(599).nullable(),
  responseMs: z.number().int().nonnegative(),
  error: z.string().max(300).nullable(),
});
export type UptimeProbeResult = z.infer<typeof UptimeProbeResult>;

export const UptimeJobResult = z.object({
  results: z.array(UptimeProbeResult).max(MAX_UPTIME_PROBES),
  durationMs: z.number(),
});
export type UptimeJobResult = z.infer<typeof UptimeJobResult>;

/** Whether an HTTP answer counts as up: any status below 500 (a 401/403 password-protected or
 * firewalled site is still serving), unless the body is a PHP / WordPress error page. */
export function uptimeStatusOk(status: number, criticalBody: boolean): boolean {
  return status < 500 && !criticalBody;
}

export interface UptimeState {
  /** Failed checks in a row. */
  failures: number;
  /** An incident is open. */
  down: boolean;
}

/**
 * Next state after one check. `excluded` checks (a hub job holds the site, e.g. a deploy in
 * maintenance mode) never count towards "down", but a good one still closes an incident.
 */
export function nextUptimeState(
  prev: UptimeState,
  ok: boolean,
  excluded: boolean,
): UptimeState & { opened: boolean; closed: boolean } {
  if (ok) return { failures: 0, down: false, opened: false, closed: prev.down };
  if (excluded) return { ...prev, opened: false, closed: false };
  const failures = prev.failures + 1;
  const down = prev.down || failures >= UPTIME_DOWN_AFTER;
  return { failures, down, opened: down && !prev.down, closed: false };
}

/** Share of good checks as a percentage, rounded down to 2 decimals (one failure never shows
 * as 100%); null without checks. */
export function uptimePercent(checks: number, failed: number): number | null {
  if (checks <= 0) return null;
  return Math.floor(((checks - failed) / checks) * 10_000) / 100;
}

export const UptimeStateName = z.enum(["up", "down", "paused", "unknown"]);
export type UptimeStateName = z.infer<typeof UptimeStateName>;

export const UptimeWindow = z.object({
  checks: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  percent: z.number().nullable(),
  avgResponseMs: z.number().int().nullable(),
});
export type UptimeWindow = z.infer<typeof UptimeWindow>;

/** One production environment's uptime (overview rows, site tab). */
export const UptimeSiteView = z.object({
  siteId: id,
  siteName: z.string(),
  url: z.string(),
  state: UptimeStateName,
  enabled: z.boolean(),
  checkedAt: iso.nullable(),
  status: z.number().int().nullable(),
  responseMs: z.number().int().nullable(),
  error: z.string().nullable(),
  /** Start of the open incident. */
  downSince: iso.nullable(),
  day: UptimeWindow,
  week: UptimeWindow,
  month: UptimeWindow,
});
export type UptimeSiteView = z.infer<typeof UptimeSiteView>;

export const UptimeIncidentView = z.object({
  id,
  siteId: id,
  siteName: z.string(),
  startedAt: iso,
  endedAt: iso.nullable(),
  /** recovered | paused (monitoring turned off or site archived while down). */
  endReason: z.string().nullable(),
  error: z.string().nullable(),
  failedChecks: z.number().int(),
});
export type UptimeIncidentView = z.infer<typeof UptimeIncidentView>;

export const UptimeRunStatus = z.object({
  running: z.boolean(),
  lastAttemptAt: iso.nullable(),
  lastSuccessAt: iso.nullable(),
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type UptimeRunStatus = z.infer<typeof UptimeRunStatus>;

export const UptimeOverview = z.object({
  status: UptimeRunStatus,
  intervalMinutes: z.number().int(),
  sites: z.array(UptimeSiteView),
  /** Open incidents and those started in the last 30 days, newest first. */
  incidents: z.array(UptimeIncidentView),
});
export type UptimeOverview = z.infer<typeof UptimeOverview>;

export const UptimeHour = z.object({
  hour: iso,
  checks: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  avgResponseMs: z.number().int().nullable(),
});
export type UptimeHour = z.infer<typeof UptimeHour>;

/** The site "Uptime & SSL" tab: null `monitor` when the site has no production environment. */
export const SiteUptimeView = z.object({
  status: UptimeRunStatus,
  intervalMinutes: z.number().int(),
  monitor: UptimeSiteView.nullable(),
  /** The last 24 hours, oldest first. */
  hours: z.array(UptimeHour),
  incidents: z.array(UptimeIncidentView),
});
export type SiteUptimeView = z.infer<typeof SiteUptimeView>;

/** Short summary on the sites list (production environment). */
export const UptimeSummary = z.object({
  state: UptimeStateName,
  since: iso.nullable(),
  percent24h: z.number().nullable(),
  responseMs: z.number().int().nullable(),
});
export type UptimeSummary = z.infer<typeof UptimeSummary>;

export const SetUptimeEnabled = z.object({ enabled: z.boolean() });
export type SetUptimeEnabled = z.infer<typeof SetUptimeEnabled>;
