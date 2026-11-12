// Expiry badges for SSL certificates and domains (A148): muted status colours only.
import { expiryTone, type ExpiryTone } from "@ulixops/shared";
import { cn } from "@/lib/utils";

const TONES: Record<ExpiryTone, string> = {
  ok: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  critical: "bg-destructive/10 text-destructive",
  expired: "bg-destructive/10 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

export function daysText(days: number): string {
  if (days < 0) return `expired ${-days} day${days === -1 ? "" : "s"} ago`;
  if (days === 0) return "expires today";
  return `${days} day${days === 1 ? "" : "s"} left`;
}

/** Days left, coloured by how close it is; `problem` overrides with a red "Problem" label. */
export function ExpiryBadge({
  days,
  problem,
  label,
}: {
  days: number | null;
  problem?: boolean;
  label?: string;
}) {
  const tone = problem && (days === null || days >= 0) ? "critical" : expiryTone(days);
  const text =
    label ??
    (problem && (days === null || days >= 0)
      ? "Problem"
      : days === null
        ? "Unknown"
        : days < 0
          ? "Expired"
          : daysText(days));
  return (
    <span
      className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone])}
    >
      {text}
    </span>
  );
}

/** "2027-03-01" from an ISO date. */
export function dateOnly(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}
