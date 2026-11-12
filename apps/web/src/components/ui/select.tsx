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

/** Invite / Admin role picker. Pass `includeSuperAdmin` only for Super Admins changing roles (A172). */
export function RoleOptions({ includeSuperAdmin = false }: { includeSuperAdmin?: boolean } = {}) {
  return (
    <>
      <option value="VIEWER">Viewer: read-only (all sites)</option>
      <option value="CLIENT_VIEWER">Client Viewer: read-only for one site tag</option>
      <option value="DEVELOPER">Developer: deploys to staging and single sites</option>
      <option value="ADMIN">Admin: full access</option>
      {includeSuperAdmin && (
        <option value="SUPER_ADMIN">
          Super Admin: self-approves risky actions (Admin with 2FA only)
        </option>
      )}
    </>
  );
}
