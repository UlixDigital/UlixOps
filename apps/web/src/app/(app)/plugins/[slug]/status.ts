import type { InstallStatus } from "@ulixops/shared";

/** Labels and badge tones for where a site stands against the registry (shared by server and client). */
export const STATUS: Record<InstallStatus, { label: string; tone: string; rank: number }> = {
  outdated: { label: "Outdated", tone: "bg-warning/10 text-warning", rank: 0 },
  newer: { label: "Newer than registry", tone: "bg-warning/10 text-warning", rank: 1 },
  latest: { label: "Latest", tone: "bg-success/10 text-success", rank: 2 },
  not_installed: { label: "Not installed", tone: "bg-muted text-muted-foreground", rank: 3 },
  unknown: { label: "No inventory yet", tone: "bg-muted text-muted-foreground", rank: 4 },
};
