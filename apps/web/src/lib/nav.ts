import { can, isClientViewer, type Permission, type RoleName } from "@ulixops/shared";

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
  | "reports"
  | "followup";

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
  { href: "/security", label: "Security", icon: "security", permission: "sites.view" },
  { href: "/monitoring", label: "Monitoring", icon: "monitoring", permission: "sites.view" },
  { href: "/dns", label: "DNS", icon: "dns", permission: "sites.view" },
  { href: "/reports", label: "Reports", icon: "reports", permission: "dashboard.view" },
  // Not in the spec's sidebar list, but screen 12 needs a home; Admins only (agent decision A48).
  { href: "/approvals", label: "Approvals", icon: "approvals", permission: "approvals.decide" },
  { href: "/audit", label: "Audit log", icon: "audit", permission: "audit.view" },
  // Super Admin only: who saw each alert, who fixed it and whether the fix held (A158).
  { href: "/follow-up", label: "Alert follow-up", icon: "followup", permission: "alerts.track" },
  { href: "/settings", label: "Settings", icon: "settings", permission: "settings.manage" },
];

/** Client Viewer sidebar (A178): tag-scoped read-only surfaces only. */
const CLIENT_VIEWER_HREFS = new Set(["/", "/sites", "/security", "/monitoring", "/reports"]);

const LATER: NavItem[] = [];

const visible = (items: NavItem[], role: RoleName) =>
  items.filter((item) => {
    if (isClientViewer(role)) return CLIENT_VIEWER_HREFS.has(item.href);
    return !item.permission || can(role, item.permission);
  });

export function navFor(role: RoleName) {
  return { main: visible(MAIN, role), later: LATER };
}

/** Extra destinations for the command palette. */
export function paletteLinksFor(role: RoleName): { href: string; label: string; group: string }[] {
  const links = [{ href: "/account", label: "My account", group: "Account" }];
  if (isClientViewer(role)) {
    links.push(
      { href: "/security/malware", label: "Malware scans", group: "Security" },
      { href: "/security/integrity", label: "File integrity", group: "Security" },
      { href: "/monitoring/uptime", label: "Uptime", group: "Monitoring" },
      { href: "/monitoring/ssl", label: "SSL & domain expiry", group: "Monitoring" },
      { href: "/monitoring/php-errors", label: "PHP errors", group: "Monitoring" },
      { href: "/reports", label: "Monthly reports", group: "Reports" },
    );
    return links;
  }
  if (can(role, "sites.manage"))
    links.push({ href: "/sites/new", label: "Add site", group: "Sites" });
  if (can(role, "sites.view")) {
    links.push({ href: "/security/malware", label: "Malware scans", group: "Security" });
    links.push({ href: "/security/integrity", label: "File integrity", group: "Security" });
    links.push({ href: "/backups/full", label: "Full backups (Google Drive)", group: "Backups" });
    links.push({ href: "/backups/restore", label: "Restore from backup", group: "Backups" });
    links.push({ href: "/monitoring/uptime", label: "Uptime", group: "Monitoring" });
    links.push({ href: "/monitoring/ssl", label: "SSL & domain expiry", group: "Monitoring" });
    links.push({ href: "/monitoring/php-errors", label: "PHP errors", group: "Monitoring" });
    links.push({ href: "/monitoring/visual", label: "Visual checks", group: "Monitoring" });
    links.push({ href: "/reports", label: "Monthly reports", group: "Reports" });
    links.push({ href: "/plugins/scheduled", label: "Scheduled updates", group: "Plugins" });
  }
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
