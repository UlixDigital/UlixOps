import type { EnvKind } from "@ulixops/shared";
import { ENV_LABELS } from "@/lib/site-status";
import { cn } from "@/lib/utils";

/** Clear Production vs Staging chip for lists and headings. */
export function EnvBadge({ kind }: { kind: EnvKind }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        kind === "STAGING" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground",
      )}
    >
      {ENV_LABELS[kind]}
    </span>
  );
}
