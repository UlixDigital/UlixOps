// Scheduled updates (A162): window maths and what a run installs.
import { describe, expect, it } from "vitest";
import {
  autoUpdateDue,
  autoUpdateWindowStart,
  AutoUpdateEnableRequest,
  AutoUpdateSettingsRequest,
  coreAutoSafe,
  nextAutoUpdateWindow,
  planAutoUpdates,
  pruneHolds,
  verifiedVersions,
} from "./autoupdates";

// Sunday 2026-11-01 12:30 UTC.
const NOW = new Date(Date.UTC(2026, 10, 1, 12, 30));

describe("autoUpdateWindowStart", () => {
  it("finds this week's window when it already opened", () => {
    expect(autoUpdateWindowStart({ dayOfWeek: 0, hourUtc: 12 }, NOW).toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
  });
  it("goes back a week when today's window is still ahead", () => {
    expect(autoUpdateWindowStart({ dayOfWeek: 0, hourUtc: 13 }, NOW).toISOString()).toBe(
      "2026-10-25T13:00:00.000Z",
    );
  });
  it("finds an earlier weekday", () => {
    expect(autoUpdateWindowStart({ dayOfWeek: 2, hourUtc: 6 }, NOW).toISOString()).toBe(
      "2026-10-27T06:00:00.000Z",
    );
  });
  it("next window is a week after the last one", () => {
    expect(nextAutoUpdateWindow({ dayOfWeek: 2, hourUtc: 6 }, NOW).toISOString()).toBe(
      "2026-11-03T06:00:00.000Z",
    );
  });
});

describe("autoUpdateDue", () => {
  const base = { enabled: true, dayOfWeek: 0, hourUtc: 12, lastWindowAt: null };
  it("is due inside the window when it hasn't run", () => {
    expect(autoUpdateDue(base, NOW)).toBe(true);
  });
  it("is not due when switched off", () => {
    expect(autoUpdateDue({ ...base, enabled: false }, NOW)).toBe(false);
  });
  it("runs once per window", () => {
    expect(autoUpdateDue({ ...base, lastWindowAt: new Date("2026-11-01T12:00:00Z") }, NOW)).toBe(
      false,
    );
    expect(autoUpdateDue({ ...base, lastWindowAt: new Date("2026-10-25T12:00:00Z") }, NOW)).toBe(
      true,
    );
  });
  it("still starts up to 3 hours late, never later", () => {
    expect(autoUpdateDue({ ...base, hourUtc: 10 }, NOW)).toBe(true);
    expect(autoUpdateDue({ ...base, hourUtc: 9 }, NOW)).toBe(false);
  });
});

describe("coreAutoSafe", () => {
  it("allows maintenance releases on the same branch", () => {
    expect(coreAutoSafe("6.8", "6.8.1")).toBe(true);
    expect(coreAutoSafe("6.8.1", "6.8.3")).toBe(true);
  });
  it("treats x.y changes as major (WordPress numbering)", () => {
    expect(coreAutoSafe("6.8.3", "6.9")).toBe(false);
    expect(coreAutoSafe("6.9", "7.0")).toBe(false);
  });
  it("refuses downgrades and odd versions", () => {
    expect(coreAutoSafe("6.8.3", "6.8.2")).toBe(false);
    expect(coreAutoSafe("6.8-beta", "6.8.1")).toBe(false);
  });
});

const INV = {
  plugins: [
    { name: "akismet", version: "5.3", updateVersion: "5.3.1" }, // patch
    { name: "contact-form-7", version: "5.9", updateVersion: "5.10" }, // minor
    { name: "elementor", version: "3.25.0", updateVersion: "4.0.0" }, // major
    { name: "woocommerce", version: "9.1", updateVersion: "9.2" }, // skip list
    { name: "hello", version: "1.7", updateVersion: null },
    { name: "odd", version: "trunk", updateVersion: "1.0" }, // unknown
  ],
  themes: [{ name: "astra", version: "4.8.1", updateVersion: "4.8.2" }],
  wpVersion: "6.8.1",
  coreUpdateVersion: "6.8.3",
};

describe("planAutoUpdates", () => {
  it("installs patch and minor, lists majors, honours the skip list", () => {
    const plan = planAutoUpdates(INV, {
      skip: [{ asset: "plugin", name: "woocommerce" }],
      holds: [],
    });
    expect(plan.auto.map((c) => `${c.asset}:${c.name}`)).toEqual([
      "plugin:akismet",
      "plugin:contact-form-7",
      "theme:astra",
      "core:wordpress",
    ]);
    expect(plan.manual.map((c) => c.name)).toEqual(["elementor", "odd"]);
    expect(plan.skipped).toMatchObject([{ name: "woocommerce", reason: "skip_list" }]);
  });

  it("lists a new WordPress branch for a manual update", () => {
    const plan = planAutoUpdates(
      { ...INV, plugins: [], themes: [], coreUpdateVersion: "6.9" },
      { skip: [], holds: [] },
    );
    expect(plan.auto).toEqual([]);
    expect(plan.manual).toMatchObject([{ asset: "core", updateVersion: "6.9", safety: "major" }]);
  });

  it("doesn't retry a held version, but tries a newer one", () => {
    const hold = { asset: "plugin" as const, name: "akismet", at: "", reason: "" };
    const held = planAutoUpdates(INV, { skip: [], holds: [{ ...hold, version: "5.3.1" }] });
    expect(held.skipped).toMatchObject([{ name: "akismet", reason: "held" }]);
    const newer = planAutoUpdates(INV, { skip: [], holds: [{ ...hold, version: "5.3.0" }] });
    expect(newer.auto.some((c) => c.name === "akismet")).toBe(true);
  });

  it("on production, installs only versions staging is running", () => {
    const staging = {
      plugins: [
        { name: "akismet", version: "5.3.1", updateVersion: null },
        { name: "contact-form-7", version: "5.9", updateVersion: "5.10" },
      ],
      themes: [{ name: "astra", version: "4.8.2", updateVersion: null }],
      wpVersion: "6.8.3",
    };
    const plan = planAutoUpdates(INV, {
      skip: [],
      holds: [],
      verified: verifiedVersions(staging),
    });
    expect(plan.auto.map((c) => c.name)).toEqual(["akismet", "astra", "wordpress"]);
    expect(plan.skipped).toMatchObject([
      { name: "contact-form-7", reason: "not_tested_on_staging" },
      { name: "woocommerce", reason: "not_tested_on_staging" },
    ]);
  });
});

describe("pruneHolds", () => {
  it("keeps a hold only while that version is still offered", () => {
    const holds = [
      { asset: "plugin" as const, name: "akismet", version: "5.3.1", at: "", reason: "" },
      { asset: "plugin" as const, name: "gone", version: "1.0", at: "", reason: "" },
    ];
    const plan = planAutoUpdates(INV, { skip: [], holds });
    expect(pruneHolds(holds, [...plan.auto, ...plan.skipped])).toEqual([holds[0]]);
  });
});

describe("requests", () => {
  it("refuses flag-like skip names and bad windows", () => {
    expect(
      AutoUpdateSettingsRequest.safeParse({
        dayOfWeek: 1,
        hourUtc: 3,
        skip: [{ asset: "plugin", name: "--all" }],
      }).success,
    ).toBe(false);
    expect(
      AutoUpdateSettingsRequest.safeParse({ dayOfWeek: 7, hourUtc: 3, skip: [] }).success,
    ).toBe(false);
    expect(AutoUpdateEnableRequest.safeParse({ siteIds: [] }).success).toBe(false);
  });
});
