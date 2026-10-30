import { can, type Permission, type RoleName } from "@ulixops/shared";

export type NavIcon =
  | "dashboard"
  | "sites"
  | "approvals"
  | "plugins"
  | "deployments"
  | "notifications"
  | "backups"
  | "audit"
  | "settings"
  | "security"
  | "dns"
  | "monitoring"
  | "reports";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  permission?: Permission;
  /** Not built yet: shown as "Coming soon" with when it arrives. */
  soon?: string;
}

// Spec 3a sidebar order. Phase 1 screens not built yet are listed with their Build Order step.
const MAIN: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/sites", label: "Sites", icon: "sites", permission: "sites.view" },
  { href: "/plugins", label: "Plugins", icon: "plugins", permission: "plugins.view" },
  {
    href: "/deployments",
    label: "Deployments",
    icon: "deployments",
    permission: "deployments.view",
  },
  {
    href: "/notifications",
    label: "Notifications",
    icon: "notifications",
    permission: "notifications.view",
  },
  { href: "/backups", label: "Backups", icon: "backups", permission: "sites.view" },
  // Not in the spec's sidebar list, but screen 12 needs a home; Admins only (agent decision A48).
  { href: "/approvals", label: "Approvals", icon: "approvals", permission: "approvals.decide" },
  { href: "/audit", label: "Audit log", icon: "audit", permission: "audit.view" },
  { href: "/settings", label: "Settings", icon: "settings", permission: "settings.manage" },
];

const LATER: NavItem[] = [
  { href: "/security", label: "Security", icon: "security", soon: "Phase 2" },
  { href: "/dns", label: "DNS", icon: "dns", soon: "Phase 3" },
  { href: "/monitoring", label: "Monitoring", icon: "monitoring", soon: "Phase 3" },
  { href: "/reports", label: "Reports", icon: "reports", soon: "Phase 4" },
];

const visible = (items: NavItem[], role: RoleName) =>
  items.filter((item) => !item.permission || can(role, item.permission));

export function navFor(role: RoleName) {
  return { main: visible(MAIN, role), later: LATER };
}

/** Extra destinations for the command palette. */
export function paletteLinksFor(role: RoleName): { href: string; label: string; group: string }[] {
  const links = [{ href: "/account", label: "My account", group: "Account" }];
  if (can(role, "sites.manage"))
    links.push({ href: "/sites/new", label: "Add site", group: "Sites" });
  if (can(role, "plugins.upload"))
    links.push({ href: "/plugins/upload", label: "Upload plugin version", group: "Plugins" });
  if (can(role, "deploy.single") || can(role, "deploy.bulk.request"))
    links.push({ href: "/deployments/new", label: "New deployment", group: "Deployments" });
  if (can(role, "secrets.manage"))
    links.push({
      href: "/settings/credentials",
      label: "Credentials (SSH keys)",
      group: "Settings",
    });
  if (can(role, "users.manage"))
    links.push({ href: "/settings/users", label: "Users & roles", group: "Settings" });
  if (can(role, "settings.manage"))
    links.push({ href: "/settings/ip-allowlist", label: "IP allowlist", group: "Settings" });
  return links;
}
