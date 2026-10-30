import { describe, expect, it } from "vitest";
import { isMajorVersionBump, SnapshotRetentionSetting, versionJumpSafety } from "./snapshots";

describe("isMajorVersionBump", () => {
  it.each([
    ["1.9.0", "2.0.0", true],
    ["1.9", "2.0", true],
    ["2.0.0", "2.1.0", false],
    ["2.0.0", "2.0.1", false],
    ["1.0.0-beta", "2.0.0", true],
    ["", "2.0", false],
    ["1.0", "", false],
    ["abc", "2.0", false],
  ])("%s → %s = %s", (from, to, expected) => {
    expect(isMajorVersionBump(from, to)).toBe(expected);
  });
});

describe("versionJumpSafety", () => {
  it.each([
    ["1.9.0", "2.0.0", "major"],
    ["2.0.0", "2.1.0", "minor"],
    ["2.0.0", "2.0.1", "patch"],
    ["abc", "2.0", "unknown"],
  ] as const)("%s → %s = %s", (from, to, expected) => {
    expect(versionJumpSafety(from, to)).toBe(expected);
  });
});

describe("SnapshotRetentionSetting", () => {
  it("accepts 1–90 days", () => {
    expect(SnapshotRetentionSetting.parse({ days: 7 })).toEqual({ days: 7 });
    expect(SnapshotRetentionSetting.safeParse({ days: 0 }).success).toBe(false);
    expect(SnapshotRetentionSetting.safeParse({ days: 91 }).success).toBe(false);
  });
});
