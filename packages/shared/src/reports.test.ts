import { describe, expect, it } from "vitest";
import {
  alertBelongsToSiteProduction,
  formatDurationMs,
  isReportIssueKind,
  monthLabelUtc,
  monthWindowUtc,
  previousMonthWindowUtc,
  ReportSummary,
} from "./reports";

describe("month windows", () => {
  it("returns the UTC calendar month containing the date", () => {
    const { start, end } = monthWindowUtc(new Date("2026-11-15T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  it("returns the previous UTC month", () => {
    const { start, end } = previousMonthWindowUtc(new Date("2026-11-01T00:00:00Z"));
    expect(start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(monthLabelUtc(start)).toBe("October 2026");
  });
});

describe("formatDurationMs", () => {
  it("formats short and long spans", () => {
    expect(formatDurationMs(18 * 60_000)).toBe("18m");
    expect(formatDurationMs(2 * 3_600_000 + 28 * 60_000)).toBe("2h 28m");
    expect(formatDurationMs(3 * 86_400_000, { ongoing: true })).toBe("3d so far");
  });
});

describe("report issue filters (A166)", () => {
  it("allows monitoring kinds and rejects approvals / deploys", () => {
    expect(isReportIssueKind("malware.found")).toBe(true);
    expect(isReportIssueKind("uptime.down")).toBe(true);
    expect(isReportIssueKind("approval.requested")).toBe(false);
    expect(isReportIssueKind("deployment.failed")).toBe(false);
    expect(isReportIssueKind("approval.self_approved")).toBe(false);
  });

  it("keeps only single-site production-scoped alerts", () => {
    const base = {
      siteId: "site1",
      productionEnvId: "env-prod",
      nonProductionEnvIds: ["env-stg"],
    };
    expect(
      alertBelongsToSiteProduction({
        ...base,
        siteIds: ["site1"],
        scope: "env-prod",
        kind: "malware.found",
      }),
    ).toBe(true);
    expect(
      alertBelongsToSiteProduction({
        ...base,
        siteIds: ["site1"],
        scope: "env-stg",
        kind: "malware.found",
      }),
    ).toBe(false);
    expect(
      alertBelongsToSiteProduction({
        ...base,
        siteIds: ["site1", "site2"],
        scope: "env-prod",
        kind: "malware.found",
      }),
    ).toBe(false);
    expect(
      alertBelongsToSiteProduction({
        ...base,
        siteIds: ["site1"],
        scope: null,
        kind: "approval.requested",
      }),
    ).toBe(false);
  });
});

describe("ReportSummary", () => {
  it("parses a per-site summary with issues", () => {
    const s = ReportSummary.parse({
      siteId: "abc123",
      siteName: "Example",
      siteUrl: "https://example.com",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      label: "October 2026",
      glance: {
        raised: 2,
        open: 1,
        fixed: 1,
        cleared: 0,
        medianFixMs: 18 * 60_000,
        medianFixLabel: "18m",
      },
      severity: { critical: 1, warning: 1, info: 0 },
      issues: [
        {
          alertId: "alert1",
          title: "Site down",
          severity: "critical",
          action: "Fixed it at the host (WP Engine, PHP, cache, server)",
          raisedAt: "2026-10-12T14:02:00.000Z",
          fixedAt: "2026-10-12T14:20:00.000Z",
          durationMs: 18 * 60_000,
          durationLabel: "18m",
          status: "fixed",
        },
      ],
      ops: {
        malwareScans: 4,
        malwareInfected: 0,
        vulnsOpen: 0,
        vulnsNew: 0,
        vulnsResolved: 1,
        integrityChanged: 0,
        phpFatals: 0,
        visualChanged: 0,
        visualFailed: 0,
        uptimePercent: 99.5,
        incidents: 1,
        downtimeMinutes: 18,
        sslExpiresAt: null,
        domainExpiresAt: null,
      },
    });
    expect(s.issues).toHaveLength(1);
    expect(s.glance.open).toBe(1);
  });
});
