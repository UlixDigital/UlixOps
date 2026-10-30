import type { UserSummary } from "@ulixops/shared";

export function statusOf(user: UserSummary): { label: string; tone: string } {
  if (!user.active) return { label: "Deactivated", tone: "bg-destructive/10 text-destructive" };
  if (user.setupPending) return { label: "Invited", tone: "bg-warning/10 text-warning" };
  if (!user.twoFactorEnabled) return { label: "2FA reset", tone: "bg-warning/10 text-warning" };
  return { label: "Active", tone: "bg-success/10 text-success" };
}
