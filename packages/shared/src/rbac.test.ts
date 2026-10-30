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
  "dashboard.view": ["ADMIN", "DEVELOPER", "VIEWER"],
  "sites.view": ["ADMIN", "DEVELOPER", "VIEWER"],
  "plugins.view": ["ADMIN", "DEVELOPER", "VIEWER"],
  "deployments.view": ["ADMIN", "DEVELOPER", "VIEWER"],
  "notifications.view": ["ADMIN", "DEVELOPER", "VIEWER"],
  "plugins.upload": ["ADMIN", "DEVELOPER"],
  "deploy.staging": ["ADMIN", "DEVELOPER"],
  "deploy.single": ["ADMIN", "DEVELOPER"],
  "deploy.bulk.request": ["ADMIN", "DEVELOPER"],
  "sites.refresh": ["ADMIN", "DEVELOPER"],
  "site.emergency": ["ADMIN", "DEVELOPER"],
  "sites.manage": ["ADMIN"],
  "secrets.manage": ["ADMIN"],
  "users.manage": ["ADMIN"],
  "settings.manage": ["ADMIN"],
  "approvals.decide": ["ADMIN"],
  "audit.view": ["ADMIN"],
};
const ROLES: RoleName[] = ["ADMIN", "DEVELOPER", "VIEWER"];

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
