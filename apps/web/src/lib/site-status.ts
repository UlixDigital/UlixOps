import {
  type EnvironmentView,
  phpSupport,
  type Severity,
  type SiteView,
  SEVERITY_ORDER,
  type VulnSummary,
} from "@ulixops/shared";

export interface Status {
  label: string;
  tone: string;
  rank: number;
}

const UNTESTED: Status = { label: "Not tested", tone: "bg-muted text-muted-foreground", rank: 1 };

/** The result of the last Test connection for one environment. */
export function connectionStatus(env: EnvironmentView): Status {
  if (env.lastTestOk === true)
    return { label: "Connected", tone: "bg-success/10 text-success", rank: 0 };
  if (env.lastTestOk === false)
    return { label: "Failed", tone: "bg-destructive/10 text-destructive", rank: 3 };
  // Tested before, but the connection details changed since (an approved change).
  if (env.lastTestAt)
    return { label: "Re-test needed", tone: "bg-warning/10 text-warning", rank: 2 };
  return UNTESTED;
}

/** The result of the last health check for one environment (Build Order step 9). */
export function healthStatus(env: EnvironmentView): Status {
  if (env.lastHealthOk === true)
    return { label: "Healthy", tone: "bg-success/10 text-success", rank: 0 };
  if (env.lastHealthOk === false)
    return { label: "Unhealthy", tone: "bg-destructive/10 text-destructive", rank: 3 };
  return { label: "Not checked", tone: "bg-muted text-muted-foreground", rank: 1 };
}

/** Worst health across a site's environments (unhealthy beats unchecked). */
export function siteHealthStatus(site: SiteView): Status {
  return site.environments
    .map(healthStatus)
    .reduce((worst, s) => (s.rank > worst.rank ? s : worst), { ...UNTESTED, rank: -1 });
}

/** Uptime of the production environment (Phase 3 step 2); rank sorts down sites first. */
export function siteUptimeStatus(site: SiteView): Status & { percent: number | null } {
  const uptime = site.environments.find((e) => e.kind === "PRODUCTION")?.uptime;
  switch (uptime?.state) {
    case "down":
      return {
        label: "Down",
        tone: "bg-destructive/10 text-destructive",
        rank: 3,
        percent: uptime.percent24h,
      };
    case "up":
      return {
        label: "Up",
        tone: "bg-success/10 text-success",
        rank: uptime.percent24h !== null && uptime.percent24h < 99 ? 2 : 0,
        percent: uptime.percent24h,
      };
    case "paused":
      return { label: "Paused", tone: "bg-muted text-muted-foreground", rank: -1, percent: null };
    default:
      return { label: "—", tone: "", rank: -2, percent: null };
  }
}

/** The worst status across a site's environments. */
export function siteStatus(site: SiteView): Status {
  return site.environments
    .map(connectionStatus)
    .reduce((worst, s) => (s.rank > worst.rank ? s : worst), { ...UNTESTED, rank: -1 });
}

/** PHP support status for one environment's version (Phase 2 step 1). */
export function phpStatus(version: string | null | undefined): Status & { title: string } {
  const support = phpSupport(version);
  const until = support.securityUntil ? ` until ${support.securityUntil}` : "";
  switch (support.status) {
    case "supported":
      return {
        label: "Supported",
        tone: "bg-success/10 text-success",
        rank: 0,
        title: `PHP ${support.branch} is fully supported${until ? ` (security fixes${until})` : ""}.`,
      };
    case "security":
      return {
        label: "Security only",
        tone: "bg-muted text-muted-foreground",
        rank: 1,
        title: `PHP ${support.branch} gets security fixes only${until}.`,
      };
    case "ending":
      return {
        label: "Ending soon",
        tone: "bg-warning/10 text-warning",
        rank: 2,
        title: `PHP ${support.branch} stops getting security fixes on ${support.securityUntil}. Plan an upgrade.`,
      };
    case "eol":
      return {
        label: "End of life",
        tone: "bg-destructive/10 text-destructive",
        rank: 3,
        title: `PHP ${support.branch} no longer gets security fixes. Upgrade now.`,
      };
    default:
      return {
        label: "Unknown",
        tone: "bg-muted text-muted-foreground",
        rank: -1,
        title: "PHP version not read yet.",
      };
  }
}

/** Vulnerability severity badge (Phase 2 step 2). Status colours only, per the UI rules. */
export const SEVERITY: Record<Severity, { label: string; tone: string }> = {
  critical: { label: "Critical", tone: "bg-destructive/10 text-destructive" },
  high: { label: "High", tone: "bg-destructive/10 text-destructive" },
  medium: { label: "Medium", tone: "bg-warning/10 text-warning" },
  low: { label: "Low", tone: "bg-muted text-muted-foreground" },
  unknown: { label: "Unrated", tone: "bg-muted text-muted-foreground" },
};

/** Open findings on a site's environments, for the sites list. Rank sorts worst last. */
export function siteVulnStatus(site: SiteView): Status & { open: number } {
  const summaries = site.environments
    .map((e) => e.vulnerabilities)
    .filter((v): v is VulnSummary => v !== undefined);
  if (summaries.length === 0) return { label: "—", tone: "", rank: -1, open: 0 };
  const open = summaries.reduce((sum, v) => sum + v.open, 0);
  if (open === 0) return { label: "None", tone: "text-muted-foreground", rank: 0, open };
  const worst =
    SEVERITY_ORDER.find((level) => summaries.some((v) => v.worst === level)) ?? "unknown";
  return {
    label: `${open} · ${SEVERITY[worst].label}`,
    tone: SEVERITY[worst].tone,
    // More severe ranks higher; ties broken by the count.
    rank: (SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(worst)) * 10_000 + open,
    open,
  };
}

export const HOST_LABELS = { WPENGINE: "WP Engine", OTHER: "Other" } as const;
export const ENV_LABELS = { PRODUCTION: "Production", STAGING: "Staging" } as const;
