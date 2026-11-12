import { describe, expect, it } from "vitest";
import { InviteUserRequest, UpdateUserRequest } from "./users";

describe("InviteUserRequest (A178)", () => {
  it("requires viewTag for CLIENT_VIEWER", () => {
    expect(
      InviteUserRequest.safeParse({ email: "c@example.test", role: "CLIENT_VIEWER" }).success,
    ).toBe(false);
    expect(
      InviteUserRequest.safeParse({
        email: "c@example.test",
        role: "CLIENT_VIEWER",
        viewTag: "acme",
      }).success,
    ).toBe(true);
  });

  it("forbids viewTag on other roles", () => {
    expect(
      InviteUserRequest.safeParse({
        email: "v@example.test",
        role: "VIEWER",
        viewTag: "acme",
      }).success,
    ).toBe(false);
    expect(InviteUserRequest.safeParse({ email: "v@example.test", role: "VIEWER" }).success).toBe(
      true,
    );
  });

  it("normalizes the tag", () => {
    const parsed = InviteUserRequest.parse({
      email: "c@example.test",
      role: "CLIENT_VIEWER",
      viewTag: "  Acme Co ",
    });
    expect(parsed.viewTag).toBe("acme co");
  });
});

describe("UpdateUserRequest (A178)", () => {
  it("requires viewTag when promoting to CLIENT_VIEWER", () => {
    expect(UpdateUserRequest.safeParse({ role: "CLIENT_VIEWER" }).success).toBe(false);
    expect(UpdateUserRequest.safeParse({ role: "CLIENT_VIEWER", viewTag: null }).success).toBe(
      false,
    );
    expect(UpdateUserRequest.safeParse({ role: "CLIENT_VIEWER", viewTag: "acme" }).success).toBe(
      true,
    );
  });

  it("forbids viewTag when setting a non-client role", () => {
    expect(UpdateUserRequest.safeParse({ role: "VIEWER", viewTag: "acme" }).success).toBe(false);
    expect(UpdateUserRequest.safeParse({ role: "VIEWER", viewTag: null }).success).toBe(true);
  });
});
