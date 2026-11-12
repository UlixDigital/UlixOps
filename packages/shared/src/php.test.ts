import { describe, expect, it } from "vitest";
import { PHP_BRANCHES, phpNeedsUpgrade, phpSupport } from "./php";

const at = (date: string) => new Date(`${date}T12:00:00Z`);

describe("phpSupport", () => {
  it("reads the branch from full version strings", () => {
    expect(phpSupport("8.2.27", at("2025-06-01")).branch).toBe("8.2");
    expect(phpSupport("7.4.33-1+ubuntu22.04", at("2025-06-01")).branch).toBe("7.4");
    expect(phpSupport(" 8.3 ", at("2025-06-01")).branch).toBe("8.3");
  });

  it.each([null, undefined, "", "?", "PHP", "x8.2"])("is unknown for %j", (version) => {
    expect(phpSupport(version)).toEqual({ status: "unknown", branch: null, securityUntil: null });
  });

  it("moves through supported → security → ending → eol", () => {
    expect(phpSupport("8.2.1", at("2024-06-01")).status).toBe("supported");
    expect(phpSupport("8.2.1", at("2025-03-01")).status).toBe("security");
    expect(phpSupport("8.2.1", at("2026-10-31")).status).toBe("ending");
    expect(phpSupport("8.2.1", at("2027-01-01")).status).toBe("eol");
  });

  it("counts the last day of security support as still supported", () => {
    expect(phpSupport("8.1.0", new Date("2025-12-31T23:00:00Z")).status).toBe("ending");
    expect(phpSupport("8.1.0", new Date("2026-01-01T00:00:01Z")).status).toBe("eol");
  });

  it("treats branches older than the table as end of life", () => {
    expect(phpSupport("7.3.33", at("2020-01-01"))).toEqual({
      status: "eol",
      branch: "7.3",
      securityUntil: null,
    });
    expect(phpSupport("5.6.40").status).toBe("eol");
  });

  it("treats branches newer than the table as supported", () => {
    expect(phpSupport("9.0.0").status).toBe("supported");
    expect(phpSupport("8.9.1").status).toBe("supported");
  });

  it("returns the security end date", () => {
    expect(phpSupport("8.3.10", at("2025-06-01")).securityUntil).toBe("2027-12-31");
  });

  it("keeps the table ordered oldest first with sane dates", () => {
    for (const [i, row] of PHP_BRANCHES.entries()) {
      expect(row.activeUntil < row.securityUntil).toBe(true);
      const prev = PHP_BRANCHES[i - 1];
      if (prev) expect(prev.securityUntil <= row.securityUntil).toBe(true);
    }
  });
});

describe("phpNeedsUpgrade", () => {
  it("flags ending and end-of-life versions only", () => {
    const now = at("2026-10-31");
    expect(phpNeedsUpgrade("7.4.33", now)).toBe(true);
    expect(phpNeedsUpgrade("8.2.20", now)).toBe(true);
    expect(phpNeedsUpgrade("8.3.10", now)).toBe(false);
    expect(phpNeedsUpgrade("8.4.1", now)).toBe(false);
    expect(phpNeedsUpgrade(null, now)).toBe(false);
  });
});
