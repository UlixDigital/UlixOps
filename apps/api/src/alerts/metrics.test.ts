import { describe, expect, it } from "vitest";
import {
  accuracyOf,
  claimsFrom,
  dailySeries,
  funnel,
  median,
  memberStats,
  type MetricAlert,
  type MetricEvent,
} from "./metrics";

const T0 = new Date(Date.UTC(2026, 10, 1, 8, 0, 0));
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const alert = (id: string, extra: Partial<MetricAlert> = {}): MetricAlert => ({
  id,
  actionable: true,
  severity: "critical",
  status: "OPEN",
  firstRaisedAt: T0,
  firstSeenAt: null,
  acknowledgedAt: null,
  closedAt: null,
  ...extra,
});
const ev = (
  alertId: string,
  type: string,
  minutes: number,
  userId: string | null = null,
  subjectUserId: string | null = null,
): MetricEvent => ({ alertId, type, userId, subjectUserId, createdAt: at(minutes) });

describe("claims and accuracy", () => {
  it("judges each reported fix by the next confirm / reject", () => {
    const claims = claimsFrom(
      [alert("a")],
      [
        ev("a", "RESOLVED", 30, "u1"),
        ev("a", "REJECTED", 60, null, "u1"),
        ev("a", "RESOLVED", 90, "u2"),
        ev("a", "CONFIRMED", 120, null, "u2"),
      ],
    );
    expect(claims.map((c) => [c.userId, c.verdict, c.responseMs / 60_000])).toEqual([
      ["u1", "REJECTED", 30],
      // Timed from the rejection, not from when the alert was first raised.
      ["u2", "CONFIRMED", 30],
    ]);
    expect(accuracyOf(claims)).toBe(0.5);
  });

  it("lets a later reopen overturn a confirmed fix", () => {
    const claims = claimsFrom(
      [alert("a")],
      [
        ev("a", "RESOLVED", 10, "u1"),
        ev("a", "CONFIRMED", 20, null, "u1"),
        ev("a", "REJECTED", 500, "boss", "u1"),
      ],
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.verdict).toBe("REJECTED");
  });

  it("keeps unchecked fixes out of accuracy", () => {
    const claims = claimsFrom([alert("a")], [ev("a", "RESOLVED", 5, "u1")]);
    expect(claims[0]?.verdict).toBeNull();
    expect(accuracyOf(claims)).toBeNull();
  });

  it("computes medians", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("member stats", () => {
  it("counts what each member saw, ignored and fixed", () => {
    const alerts = [alert("a", { status: "OPEN" }), alert("b", { status: "VERIFIED" })];
    const events = [
      ev("b", "ACKNOWLEDGED", 5, "u1"),
      ev("b", "RESOLVED", 20, "u1"),
      ev("b", "CONFIRMED", 40, null, "u1"),
    ];
    const stats = memberStats({
      users: [
        { id: "u1", name: "Ana", email: "ana@x.test", role: "ADMIN" },
        { id: "u2", name: "Ben", email: "ben@x.test", role: "ADMIN" },
        { id: "u3", name: "Cy", email: "cy@x.test", role: "VIEWER" },
      ],
      alerts,
      notifications: [
        { alertId: "a", userId: "u1", createdAt: T0, seenAt: at(2), readAt: null },
        { alertId: "b", userId: "u1", createdAt: T0, seenAt: at(4), readAt: at(20) },
        { alertId: "a", userId: "u2", createdAt: T0, seenAt: null, readAt: null },
      ],
      events,
      claims: claimsFrom(alerts, events),
    });
    expect(stats.map((s) => s.userId)).toEqual(["u1", "u2"]); // u3 had nothing
    expect(stats[0]).toMatchObject({
      received: 2,
      seen: 2,
      read: 1,
      medianSeenMs: 3 * 60_000,
      acknowledged: 1,
      resolved: 1,
      confirmed: 1,
      accuracy: 1,
      ignoredOpen: 0,
    });
    expect(stats[1]).toMatchObject({ received: 1, seen: 0, ignoredOpen: 1, accuracy: null });
  });
});

describe("funnel and daily series", () => {
  it("follows actionable alerts through each step", () => {
    const alerts = [
      alert("a", { firstSeenAt: at(1), acknowledgedAt: at(2), status: "VERIFIED" }),
      alert("b", { firstSeenAt: at(1) }),
      alert("c"),
      alert("i", { actionable: false, status: "INFO" }),
    ];
    const claims = claimsFrom(alerts, [ev("a", "RESOLVED", 3, "u1")]);
    expect(funnel(alerts, claims).map((s) => s.count)).toEqual([3, 2, 1, 1, 1]);
  });

  it("buckets raised and closed per UTC day", () => {
    const days = dailySeries(
      [
        alert("a", { closedAt: new Date(Date.UTC(2026, 10, 2, 1)) }),
        alert("b"),
        alert("i", { actionable: false }),
      ],
      T0,
      2,
    );
    expect(days).toEqual([
      { date: "2026-11-01", raised: 2, closed: 0 },
      { date: "2026-11-02", raised: 0, closed: 1 },
      { date: "2026-11-03", raised: 0, closed: 0 },
    ]);
  });
});
