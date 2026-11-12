// Scheduled updates (A162): labels and status colours shared by the site card and the overview.
import {
  AUTOUPDATE_STATUS_LABELS,
  type AutoUpdateOutcome,
  type AutoUpdateRunStatus,
  type AutoUpdateWindow,
  WEEKDAYS,
} from "@ulixops/shared";
import { hourLabel } from "@/lib/malware";

export const RUN_STATUS: Record<AutoUpdateRunStatus, { label: string; tone: string }> = {
  running: { label: AUTOUPDATE_STATUS_LABELS.running, tone: "bg-primary/10 text-primary" },
  completed: { label: AUTOUPDATE_STATUS_LABELS.completed, tone: "bg-success/10 text-success" },
  nothing_to_do: {
    label: AUTOUPDATE_STATUS_LABELS.nothing_to_do,
    tone: "bg-muted text-muted-foreground",
  },
  problems: {
    label: AUTOUPDATE_STATUS_LABELS.problems,
    tone: "bg-destructive/10 text-destructive",
  },
  interrupted: { label: AUTOUPDATE_STATUS_LABELS.interrupted, tone: "bg-warning/10 text-warning" },
};

export const OUTCOME: Record<AutoUpdateOutcome, { label: string; tone: string }> = {
  updated: { label: "Updated", tone: "text-success" },
  rolled_back: { label: "Rolled back", tone: "text-destructive" },
  failed: { label: "Failed", tone: "text-destructive" },
  not_run: { label: "Not run", tone: "text-warning" },
  skipped: { label: "Skipped", tone: "text-muted-foreground" },
};

export function windowLabel(w: AutoUpdateWindow): string {
  return `${WEEKDAYS[w.dayOfWeek] ?? "?"} ${hourLabel(w.hourUtc)} UTC`;
}
