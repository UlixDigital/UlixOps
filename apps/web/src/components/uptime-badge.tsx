// Uptime badges, numbers and the 24-hour strip (A149): muted status colours only.
import type { UptimeHour, UptimeStateName } from "@ulixops/shared";
import { formatUtc } from "@/lib/format";
import { cn } from "@/lib/utils";

const TONES: Record<UptimeStateName, string> = {
  up: "bg-success/10 text-success",
  down: "bg-destructive/10 text-destructive",
  paused: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};

const LABELS: Record<UptimeStateName, string> = {
  up: "Up",
  down: "Down",
  paused: "Paused",
  unknown: "Not checked yet",
};

/** "12 min", "3 h 5 min", "2 d 4 h" since an ISO time. */
export function sinceText(iso: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

/** Duration between two ISO times (an ongoing incident runs until now). */
export function durationBetween(from: string, to: string | null): string {
  return sinceText(from, to ? Date.parse(to) : Date.now());
}

export function percentText(percent: number | null): string {
  if (percent === null) return "—";
  return `${percent === 100 ? "100" : percent.toFixed(2)}%`;
}

export function msText(ms: number | null): string {
  if (ms === null) return "—";
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${ms} ms`;
}

/** Up / Down (for how long) / Paused / Not checked yet. */
export function UptimeBadge({ state, since }: { state: UptimeStateName; since?: string | null }) {
  return (
    <span
      className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", TONES[state])}
      title={since ? `Down since ${formatUtc(since)}` : undefined}
    >
      {LABELS[state]}
      {state === "down" && since ? ` · ${sinceText(since)}` : ""}
    </span>
  );
}

/** Colour of an uptime percentage: below 99% amber, below 95% red. */
export function percentTone(percent: number | null): string {
  if (percent === null || percent >= 99) return "";
  return percent >= 95 ? "text-warning" : "text-destructive";
}

/** One bar per hour, oldest left: green all good, amber some failed, red mostly failed. */
export function UptimeHoursStrip({ hours }: { hours: UptimeHour[] }) {
  return (
    <div className="grid gap-1">
      <ol aria-label="Uptime per hour, last 24 hours" className="flex h-8 items-stretch gap-0.5">
        {hours.map((h) => {
          const label = `${h.hour.slice(11, 16)} UTC: ${
            h.checks === 0
              ? "no checks"
              : `${h.checks - h.failed}/${h.checks} checks ok${h.avgResponseMs !== null ? `, ${msText(h.avgResponseMs)} average` : ""}`
          }`;
          return (
            <li
              key={h.hour}
              title={label}
              aria-label={label}
              className={cn(
                "flex-1 rounded-sm",
                h.checks === 0
                  ? "bg-muted"
                  : h.failed === 0
                    ? "bg-success/70"
                    : h.failed * 2 < h.checks
                      ? "bg-warning/70"
                      : "bg-destructive/70",
              )}
            />
          );
        })}
      </ol>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>24 hours ago</span>
        <span>Now</span>
      </div>
    </div>
  );
}
