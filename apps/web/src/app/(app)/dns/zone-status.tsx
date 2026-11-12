// Cloudflare zone status badge (A156), usable from server and client components.
import type { DnsZoneView } from "@ulixops/shared";
import { cn } from "@/lib/utils";

const badge = "rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap";

export function zoneStatusBadge(z: Pick<DnsZoneView, "status" | "paused" | "removed">) {
  if (z.removed)
    return <span className={cn(badge, "bg-muted text-muted-foreground")}>No access</span>;
  if (z.paused) return <span className={cn(badge, "bg-warning/10 text-warning")}>Paused</span>;
  return z.status === "active" ? (
    <span className={cn(badge, "bg-success/10 text-success")}>Active</span>
  ) : (
    <span
      className={cn(badge, "bg-warning/10 text-warning")}
      title="Waiting for the nameserver change"
    >
      {z.status === "pending" ? "Pending nameservers" : z.status}
    </span>
  );
}
