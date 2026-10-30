import { can } from "@ulixops/shared";
import type { ReactNode } from "react";
import { NavLink } from "@/components/nav-link";
import { NoAccess } from "@/components/no-access";
import { requireSession } from "@/lib/auth";

export default async function SettingsLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { user } = await requireSession();
  if (!can(user.role, "settings.manage")) return <NoAccess role={user.role} what="settings" />;
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <nav aria-label="Settings" className="flex flex-wrap gap-1 border-b pb-2">
          <NavLink href="/settings" exact>
            General
          </NavLink>
          {can(user.role, "users.manage") && (
            <NavLink href="/settings/users">Users &amp; roles</NavLink>
          )}
          {can(user.role, "secrets.manage") && (
            <NavLink href="/settings/credentials">Credentials</NavLink>
          )}
          <NavLink href="/settings/ip-allowlist">IP allowlist</NavLink>
        </nav>
      </div>
      {children}
    </div>
  );
}
