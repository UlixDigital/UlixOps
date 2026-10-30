import { describe, expect, it } from "vitest";
import { maintenanceFilePath } from "./maintenance";

describe("maintenanceFilePath", () => {
  it("joins .maintenance under a validated wpPath", () => {
    expect(maintenanceFilePath("/sites/houser")).toBe("/sites/houser/.maintenance");
    expect(maintenanceFilePath("/sites/houser/")).toBe("/sites/houser/.maintenance");
  });

  it("refuses paths outside the WpPath allowlist", () => {
    expect(() => maintenanceFilePath("/tmp/../etc")).toThrow();
    expect(() => maintenanceFilePath("relative")).toThrow();
  });
});
