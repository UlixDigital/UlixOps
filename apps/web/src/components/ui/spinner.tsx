import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Animated circular progress (lucide Loader2). */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <Loader2
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn("size-5 animate-spin text-primary", className)}
    />
  );
}
