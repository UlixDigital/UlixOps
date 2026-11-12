import { ALERT_STATUS_LABELS, type AlertStatus } from "@ulixops/shared";
import { CheckCircle2, CircleDot, Clock, Hand, Info, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

const STYLE: Record<AlertStatus, { className: string; Icon: typeof Info }> = {
  INFO: { className: "bg-muted text-muted-foreground", Icon: Info },
  OPEN: { className: "bg-warning/10 text-warning", Icon: CircleDot },
  ACKNOWLEDGED: { className: "bg-primary/10 text-primary", Icon: Hand },
  RESOLVED: { className: "bg-muted text-foreground", Icon: Clock },
  VERIFIED: { className: "bg-success/10 text-success", Icon: CheckCircle2 },
  AUTO_CLEARED: { className: "bg-muted text-muted-foreground", Icon: RotateCcw },
};

/** Follow-up state of an alert: icon + label, never colour alone (A158). */
export function AlertStatusBadge({
  status,
  className,
}: {
  status: AlertStatus;
  className?: string;
}) {
  const { className: tone, Icon } = STYLE[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tone,
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {ALERT_STATUS_LABELS[status]}
    </span>
  );
}

export const SEVERITY_BADGE: Record<string, string> = {
  info: "bg-muted text-muted-foreground",
  warning: "bg-warning/10 text-warning",
  critical: "bg-destructive/10 text-destructive",
};

/** Milliseconds as "4 min", "2 h 5 min", "3 d 4 h". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}
