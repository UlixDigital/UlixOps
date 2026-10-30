import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Native select styled like Input: accessible and CSP-friendly without a popup library. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function RoleOptions() {
  return (
    <>
      <option value="VIEWER">Viewer: read-only</option>
      <option value="DEVELOPER">Developer: deploys to staging and single sites</option>
      <option value="ADMIN">Admin: full access</option>
    </>
  );
}
