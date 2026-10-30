import { CircleAlert, Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Inline message. `error` is announced immediately to screen readers. */
export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error";
  children: ReactNode;
}) {
  const Icon = tone === "error" ? CircleAlert : Info;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        tone === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "bg-muted/50",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
