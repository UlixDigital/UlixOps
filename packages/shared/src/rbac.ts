// Who may do what (spec section 5, Roles). The API enforces this on every protected route;
// the web app uses it only to hide what a role cannot use.
import { z } from "zod";
import type { Role } from "./auth";

export type RoleName = z.infer<typeof Role>;

export const PERMISSIONS = {
  "dashboard.view": "See dashboards and reports",
  "sites.view": "See sites and their status",
  "plugins.view": "See the plugin registry",
  "deployments.view": "See deployments and their logs",
  "notifications.view": "See the in-app alert centre",
  "plugins.upload": "Upload custom plugin versions",
  "deploy.staging": "Deploy to staging environments",
  "deploy.single": "Deploy to a single production site",
  "deploy.bulk.request": "Request a bulk or all-sites rollout (an Admin must approve)",
  "sites.refresh": "Read a site's inventory over SSH (versions, plugins, themes)",
  "site.emergency":
    "Emergency actions on one site (deactivate a plugin, maintenance mode, flush the cache)",
  "sites.manage": "Add, edit and archive sites",
  "secrets.manage": "Manage site credentials and API tokens",
  "users.manage": "Invite users, change roles, reset 2FA",
  "settings.manage": "Change hub settings",
  "vulns.sync": "Fetch the vulnerability feed now (it also runs daily)",
  "dns.manage": "Add, edit and delete Cloudflare DNS records; request a DNS rollback",
  "backups.restore":
    "Restore a site from its Google Drive backup (a second Admin approves; it overwrites the site)",
  "approvals.decide": "Approve or reject risky actions",
  "audit.view": "Read the audit log",
  "approvals.self":
    "Approve your own risky actions at once (Super Admin; every other Admin is alerted)",
  "alerts.track":
    "See who saw each alert, who fixed it and whether the fix held; confirm or reject fixes (Super Admin)",
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const Permission = z.enum(Object.keys(PERMISSIONS) as [Permission, ...Permission[]]);

const VIEWER: readonly Permission[] = [
  "dashboard.view",
  "sites.view",
  "plugins.view",
  "deployments.view",
  "notifications.view",
];

/** Tag-scoped read-only (A178): dashboards/sites/security/monitoring/reports only via nav. */
const CLIENT_VIEWER: readonly Permission[] = ["dashboard.view", "sites.view"];

const DEVELOPER: readonly Permission[] = [
  ...VIEWER,
  "plugins.upload",
  "deploy.staging",
  "deploy.single",
  "deploy.bulk.request",
  "sites.refresh",
  "site.emergency",
];

export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  VIEWER,
  CLIENT_VIEWER,
  DEVELOPER,
  ADMIN: Permission.options.filter((p) => p !== "approvals.self" && p !== "alerts.track"),
  // Everything an Admin can do, plus approving their own risky actions (A134) and the alert
  // follow-up report (A158).
  SUPER_ADMIN: Permission.options,
};

export function can(role: RoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Who may run a single-site action (Build Order steps 6 and 8). Activating or updating a plugin
 * changes what the site runs, like a deploy, so it follows the deploy permissions; snapshots
 * that only read/write a restore point use the same deploy permission for that environment;
 * restore and the other emergency actions use site.emergency. Agent decisions A55, A72.
 */
export function siteActionPermission(
  action:
    | "plugin.activate"
    | "plugin.deactivate"
    | "plugin.update"
    | "theme.update"
    | "core.update"
    | "plugin.delete"
    | "theme.delete"
    | "snapshot.create"
    | "snapshot.restore"
    | "maintenance"
    | "cache.flush",
  environment: "PRODUCTION" | "STAGING",
): Permission {
  if (
    action === "plugin.activate" ||
    action === "plugin.update" ||
    action === "theme.update" ||
    action === "core.update" ||
    action === "plugin.delete" ||
    action === "theme.delete" ||
    action === "snapshot.create"
  ) {
    return environment === "PRODUCTION" ? "deploy.single" : "deploy.staging";
  }
  return "site.emergency";
}

/** Actions that always need a second person, an Admin, to approve (spec section 5). */
export const RISKY_ACTIONS = [
  "deploy.bulk",
  "deploy.all_sites",
  "site.delete",
  "credential.change",
  "site.bulk_update",
] as const;
export type RiskyAction = (typeof RISKY_ACTIONS)[number];

export type ApprovalDecisionCheck =
  { ok: true } | { ok: false; reason: "not_admin" | "own_request" | "already_decided" };

/**
 * Only an Admin may decide, only while it is pending, and never on their own request, except a
 * Super Admin, who self-approves (A134).
 */
export function canDecideApproval(
  request: { requestedById: string; status: string },
  decider: { id: string; role: RoleName },
): ApprovalDecisionCheck {
  if (!can(decider.role, "approvals.decide")) return { ok: false, reason: "not_admin" };
  if (request.requestedById === decider.id && !can(decider.role, "approvals.self"))
    return { ok: false, reason: "own_request" };
  if (request.status !== "PENDING") return { ok: false, reason: "already_decided" };
  return { ok: true };
}
