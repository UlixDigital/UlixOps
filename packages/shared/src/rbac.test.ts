import { describe, expect, it } from "vitest";
import {
  canDecideApproval,
  can,
  PERMISSIONS,
  type Permission,
  type RoleName,
  siteActionPermission,
} from "./rbac";

// Written out in full on purpose: any change to who may do what must change this table too.
const EXPECTED: Record<Permission, RoleName[]> = {
  "dashboard.view": ["SUPER_ADMIN", "ADMIN", "DEVELOPER", "VIEWER", "CLIENT_VIEWER"],
  "sites.view": ["SUPER_ADMIN", "ADMIN", "DEVELOPER", "VIEWER", "CLIENT_VIEWER"],
  "plugins.view": ["SUPER_ADMIN", "ADMIN", "DEVELOPER", "VIEWER"],
  "deployments.view": ["SUPER_ADMIN", "ADMIN", "DEVELOPER", "VIEWER"],
  "notifications.view": ["SUPER_ADMIN", "ADMIN", "DEVELOPER", "VIEWER"],
  "plugins.upload": ["SUPER_ADMIN", "ADMIN", "DEVELOPER"],
  "deploy.staging": ["SUPER_ADMIN", "ADMIN", "DEVELOPER"],
  "deploy.single": ["SUPER_ADMIN", "ADMIN", "DEVELOPER"],
  "deploy.bulk.request": ["SUPER_ADMIN", "ADMIN", "DEVELOPER"],
  "sites.refresh": ["SUPER_ADMIN", "ADMIN", "DEVELOPER"],
  "site.emergency": ["SUPER_ADMIN", "ADMIN", "DEVELOPER"],
  "sites.manage": ["SUPER_ADMIN", "ADMIN"],
  "secrets.manage": ["SUPER_ADMIN", "ADMIN"],
  "users.manage": ["SUPER_ADMIN", "ADMIN"],
  "settings.manage": ["SUPER_ADMIN", "ADMIN"],
  "vulns.sync": ["SUPER_ADMIN", "ADMIN"],
  "backups.restore": ["SUPER_ADMIN", "ADMIN"],
  "dns.manage": ["SUPER_ADMIN", "ADMIN"],
  "approvals.self": ["SUPER_ADMIN"],
  "alerts.track": ["SUPER_ADMIN"],
  "approvals.decide": ["SUPER_ADMIN", "ADMIN"],
  "audit.view": ["SUPER_ADMIN", "ADMIN"],
};
const ROLES: RoleName[] = ["SUPER_ADMIN", "ADMIN", "DEVELOPER", "VIEWER", "CLIENT_VIEWER"];

describe("role permissions", () => {
  it("covers every permission in the expectation table", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  for (const permission of Object.keys(EXPECTED) as Permission[]) {
    for (const role of ROLES) {
      const allowed = EXPECTED[permission].includes(role);
      it(`${role} ${allowed ? "can" : "cannot"} ${permission}`, () => {
        expect(can(role, permission)).toBe(allowed);
      });
    }
  }

  it("gives Viewers read-only access only", () => {
    for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
      if (can("VIEWER", permission)) expect(permission).toMatch(/\.view$/);
    }
  });
});

describe("single-site actions", () => {
  it("treats activating, updating and snapshotting like a deploy to that environment", () => {
    for (const action of [
      "plugin.activate",
      "plugin.update",
      "theme.update",
      "core.update",
      "plugin.delete",
      "theme.delete",
      "snapshot.create",
    ] as const) {
      expect(siteActionPermission(action, "PRODUCTION")).toBe("deploy.single");
      expect(siteActionPermission(action, "STAGING")).toBe("deploy.staging");
    }
  });

  it("treats restore, deactivate, maintenance and cache flushes as emergency actions", () => {
    for (const action of [
      "snapshot.restore",
      "plugin.deactivate",
      "maintenance",
      "cache.flush",
    ] as const) {
      for (const env of ["PRODUCTION", "STAGING"] as const) {
        expect(siteActionPermission(action, env)).toBe("site.emergency");
      }
    }
  });

  it("never lets a Viewer run one", () => {
    for (const action of [
      "plugin.activate",
      "plugin.update",
      "theme.update",
      "core.update",
      "plugin.delete",
      "theme.delete",
      "snapshot.create",
      "snapshot.restore",
      "plugin.deactivate",
      "maintenance",
      "cache.flush",
    ] as const) {
      for (const env of ["PRODUCTION", "STAGING"] as const) {
        expect(can("VIEWER", siteActionPermission(action, env))).toBe(false);
        expect(can("DEVELOPER", siteActionPermission(action, env))).toBe(true);
      }
    }
  });
});

describe("approval decisions", () => {
  const pending = { requestedById: "dev-1", status: "PENDING" };

  it("lets another Admin decide a pending request", () => {
    expect(canDecideApproval(pending, { id: "admin-1", role: "ADMIN" })).toEqual({ ok: true });
  });

  it("lets only a Super Admin approve their own request, and only while pending (A134)", () => {
    const own = { requestedById: "super-1", status: "PENDING" };
    expect(canDecideApproval(own, { id: "super-1", role: "SUPER_ADMIN" })).toEqual({ ok: true });
    expect(
      canDecideApproval({ ...own, status: "APPROVED" }, { id: "super-1", role: "SUPER_ADMIN" }),
    ).toEqual({ ok: false, reason: "already_decided" });
  });

  it("never lets the requester approve their own request, even an Admin", () => {
    const own = { requestedById: "admin-1", status: "PENDING" };
    expect(canDecideApproval(own, { id: "admin-1", role: "ADMIN" })).toEqual({
      ok: false,
      reason: "own_request",
    });
  });

  it("only lets Admins decide", () => {
    expect(canDecideApproval(pending, { id: "dev-2", role: "DEVELOPER" })).toEqual({
      ok: false,
      reason: "not_admin",
    });
    expect(canDecideApproval(pending, { id: "viewer-1", role: "VIEWER" })).toEqual({
      ok: false,
      reason: "not_admin",
    });
  });

  it("refuses requests that were already decided", () => {
    for (const status of ["APPROVED", "REJECTED"]) {
      expect(
        canDecideApproval({ requestedById: "dev-1", status }, { id: "admin-1", role: "ADMIN" }),
      ).toEqual({
        ok: false,
        reason: "already_decided",
      });
    }
  });
});
