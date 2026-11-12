import { describe, expect, it } from "vitest";
import { activeSiteWhereForUser, canAccessSite, siteWhereForUser, type AccessUser } from "./access";

const staff = (role: AccessUser["role"]): AccessUser => ({
  id: "u1",
  email: "a@example.test",
  name: null,
  role,
  viewTag: null,
});

const client = (viewTag: string | null): AccessUser => ({
  id: "c1",
  email: "client@example.test",
  name: null,
  role: "CLIENT_VIEWER",
  viewTag,
});

describe("siteWhereForUser (A178)", () => {
  it("returns no filter for staff roles", () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "DEVELOPER", "VIEWER"] as const) {
      expect(siteWhereForUser(staff(role))).toEqual({});
      expect(activeSiteWhereForUser(staff(role))).toEqual({ archived: false });
    }
  });

  it("scopes Client Viewer to their tag", () => {
    expect(siteWhereForUser(client("acme"))).toEqual({ tags: { has: "acme" } });
    expect(activeSiteWhereForUser(client("Acme Co"))).toEqual({
      archived: false,
      tags: { has: "acme co" },
    });
  });

  it("uses an impossible id when viewTag is missing", () => {
    expect(siteWhereForUser(client(null))).toEqual({ id: "__no_view_tag__" });
    expect(siteWhereForUser(client("  "))).toEqual({ id: "__no_view_tag__" });
  });
});

describe("canAccessSite (A178)", () => {
  it("allows staff any site including archived", () => {
    expect(canAccessSite(staff("VIEWER"), { tags: ["x"], archived: true })).toBe(true);
  });

  it("matches tag case-insensitively and denies archived / other tags", () => {
    const user = client("Client A");
    expect(canAccessSite(user, { tags: ["client a"], archived: false })).toBe(true);
    expect(canAccessSite(user, { tags: ["CLIENT A", "other"], archived: false })).toBe(true);
    expect(canAccessSite(user, { tags: ["other"], archived: false })).toBe(false);
    expect(canAccessSite(user, { tags: ["client a"], archived: true })).toBe(false);
  });

  it("denies when viewTag is empty", () => {
    expect(canAccessSite(client(null), { tags: ["x"], archived: false })).toBe(false);
  });
});
