import type { ApprovalBulkItemView, VersionJumpSafety } from "@ulixops/shared";
import { cn } from "@/lib/utils";

const SAFETY_LABEL: Record<VersionJumpSafety, string> = {
  patch: "Patch",
  minor: "Minor",
  major: "Major",
  unknown: "Unknown",
};

const SAFETY_CLASS: Record<VersionJumpSafety, string> = {
  patch: "bg-success/10 text-success",
  minor: "bg-muted text-muted-foreground",
  major: "bg-destructive/10 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

/** Same review list the requester saw before submitting (A108). */
export function ApprovalBulkItems({ items }: { items: ApprovalBulkItemView[] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[28rem] text-left text-sm">
        <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Current</th>
            <th className="px-3 py-2 font-medium">Target</th>
            <th className="px-3 py-2 font-medium">Jump</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((item) => (
            <tr key={`${item.asset}:${item.name}`}>
              <td className="px-3 py-2 font-mono text-xs break-all">{item.name}</td>
              <td className="px-3 py-2 capitalize text-muted-foreground">{item.asset}</td>
              <td className="px-3 py-2 font-mono text-xs">{item.version}</td>
              <td className="px-3 py-2 font-mono text-xs">{item.updateVersion}</td>
              <td className="px-3 py-2">
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-xs font-medium",
                    SAFETY_CLASS[item.safety],
                  )}
                >
                  {SAFETY_LABEL[item.safety]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
