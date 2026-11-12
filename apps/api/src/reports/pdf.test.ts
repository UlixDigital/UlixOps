import { ReportSummary } from "@ulixops/shared";
import { describe, expect, it } from "vitest";
import { buildReportPdf } from "./pdf";

const sample = ReportSummary.parse({
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

describe("buildReportPdf", () => {
  it("returns a PDF buffer with the %PDF header", async () => {
    const buf = await buildReportPdf(sample, {
      generatedAt: "2026-11-01T10:05:00.000Z",
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });
});
