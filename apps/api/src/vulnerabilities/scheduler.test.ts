import { describe, expect, it } from "vitest";
import { syncDue } from "./scheduler";

const NOW = new Date("2026-10-31T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("syncDue", () => {
  it("syncs when it never ran", () => {
    expect(syncDue({ lastSuccessAt: null, lastAttemptAt: null, ok: null }, NOW)).toBe(true);
  });

  it("waits a day after a success", () => {
    const status = (h: number) => ({
      lastSuccessAt: hoursAgo(h),
      lastAttemptAt: hoursAgo(h),
      ok: true,
    });
    expect(syncDue(status(23), NOW)).toBe(false);
    expect(syncDue(status(24), NOW)).toBe(true);
  });

  it("backs off for six hours after a failure", () => {
    const failed = (h: number) => ({ lastSuccessAt: null, lastAttemptAt: hoursAgo(h), ok: false });
    expect(syncDue(failed(1), NOW)).toBe(false);
    expect(syncDue(failed(6), NOW)).toBe(true);
    // A failure after an old success still backs off.
    expect(
      syncDue({ lastSuccessAt: hoursAgo(48), lastAttemptAt: hoursAgo(2), ok: false }, NOW),
    ).toBe(false);
  });
});
