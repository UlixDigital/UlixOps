import type { EnvironmentView, SiteView } from "@ulixops/shared";

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

/** The worst status across a site's environments. */
export function siteStatus(site: SiteView): Status {
  return site.environments
    .map(connectionStatus)
    .reduce((worst, s) => (s.rank > worst.rank ? s : worst), { ...UNTESTED, rank: -1 });
}

export const HOST_LABELS = { WPENGINE: "WP Engine", OTHER: "Other" } as const;
export const ENV_LABELS = { PRODUCTION: "Production", STAGING: "Staging" } as const;
