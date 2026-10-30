import { describe, expect, it } from "vitest";
import { compareVersions } from "./plugins";

const sign = (a: string, b: string) => Math.sign(compareVersions(a, b));

describe("compareVersions", () => {
  it.each([
    ["1.0.0", "1.0.1", -1],
    ["1.2", "1.10", -1],
    ["2.0", "1.99.99", 1],
    ["1.0", "1.0.0", 0],
    ["1.0.0", "1.0", 0],
    ["1.0-beta", "1.0", -1],
    ["1.0-alpha", "1.0-beta", -1],
    ["1.0-beta", "1.0-rc1", -1],
    ["1.0rc1", "1.0-rc.1", 0],
    ["1.0-RC2", "1.0-rc10", -1],
    ["1.0-dev", "1.0-alpha", -1],
    ["1.0", "1.0-pl1", -1],
    // As in PHP: "pl" ranks above any number.
    ["1.0.1", "1.0-pl1", -1],
    ["1.0-foo", "1.0-dev", -1],
    ["3.1.4", "3.1.4", 0],
  ])("%s vs %s → %i", (a, b, expected) => {
    expect(sign(a, b)).toBe(expected);
    expect(sign(b, a)).toBe(-expected || 0);
  });

  it("sorts a release history", () => {
    const versions = ["1.10.0", "1.2.0", "1.2.0-beta", "1.9", "2.0.0-rc1", "1.2.1"];
    expect([...versions].sort(compareVersions)).toEqual([
      "1.2.0-beta",
      "1.2.0",
      "1.2.1",
      "1.9",
      "1.10.0",
      "2.0.0-rc1",
    ]);
  });
});
