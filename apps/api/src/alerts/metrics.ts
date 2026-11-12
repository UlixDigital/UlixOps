// Pure follow-up metrics for the Super Admin report (A158). No database: easy to unit test.
import type { AlertStatus, MemberStats } from "@ulixops/shared";

export interface MetricAlert {
  id: string;
  actionable: boolean;
  severity: string;
  status: AlertStatus;
  firstRaisedAt: Date;
  firstSeenAt: Date | null;
  acknowledgedAt: Date | null;
  closedAt: Date | null;
}

export interface MetricNotification {
  alertId: string;
  userId: string;
  createdAt: Date;
  seenAt: Date | null;
  readAt: Date | null;
}

export interface MetricEvent {
  alertId: string;
  type: string;
  userId: string | null;
  subjectUserId: string | null;
  createdAt: Date;
}

export interface MetricUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

/** One reported fix and how it was judged. */
export interface Claim {
  alertId: string;
  userId: string;
  at: Date;
  /** Time from the problem (re)appearing to the fix being reported. */
  responseMs: number;
  verdict: "CONFIRMED" | "REJECTED" | null;
}

const OPEN_STATUSES: readonly AlertStatus[] = ["OPEN", "ACKNOWLEDGED"];

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Walks each alert's timeline: every RESOLVED starts a claim, the next CONFIRMED / REJECTED
 * judges it (a later judgment of the same claim overrides, e.g. a confirmed fix that a Super
 * Admin reopens). A claim is credited to whoever reported it.
 */
export function claimsFrom(alerts: MetricAlert[], events: MetricEvent[]): Claim[] {
  const raisedAt = new Map(alerts.map((a) => [a.id, a.firstRaisedAt]));
  const byAlert = new Map<string, MetricEvent[]>();
  for (const e of events) {
    const list = byAlert.get(e.alertId) ?? [];
    list.push(e);
    byAlert.set(e.alertId, list);
  }
  const claims: Claim[] = [];
  for (const [alertId, list] of byAlert) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let since = raisedAt.get(alertId) ?? list[0]?.createdAt ?? new Date(0);
    let current: Claim | null = null;
    for (const e of list) {
      if (e.type === "RESOLVED" && e.userId) {
        if (current) claims.push(current);
        current = {
          alertId,
          userId: e.userId,
          at: e.createdAt,
          responseMs: Math.max(0, e.createdAt.getTime() - since.getTime()),
          verdict: null,
        };
      } else if ((e.type === "CONFIRMED" || e.type === "REJECTED") && current) {
        current.verdict = e.type;
      }
      if (e.type === "REJECTED" || e.type === "REOPENED") since = e.createdAt;
    }
    if (current) claims.push(current);
  }
  return claims;
}

export function accuracyOf(claims: Claim[]): number | null {
  const confirmed = claims.filter((c) => c.verdict === "CONFIRMED").length;
  const rejected = claims.filter((c) => c.verdict === "REJECTED").length;
  return confirmed + rejected === 0 ? null : confirmed / (confirmed + rejected);
}

export function memberStats(input: {
  users: MetricUser[];
  alerts: MetricAlert[];
  notifications: MetricNotification[];
  events: MetricEvent[];
  claims: Claim[];
}): MemberStats[] {
  const alerts = new Map(input.alerts.map((a) => [a.id, a]));
  const ids = new Set<string>(input.users.map((u) => u.id));
  return input.users
    .filter((u) => ids.has(u.id))
    .map((u) => {
      const mine = input.notifications.filter((n) => n.userId === u.id);
      const seen = mine.filter((n) => n.seenAt);
      const claims = input.claims.filter((c) => c.userId === u.id);
      const ignoredOpen = mine.filter((n) => {
        const a = alerts.get(n.alertId);
        return a?.actionable && OPEN_STATUSES.includes(a.status) && !n.seenAt;
      }).length;
      return {
        userId: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        received: mine.length,
        seen: seen.length,
        read: mine.filter((n) => n.readAt).length,
        ignoredOpen,
        medianSeenMs: median(
          seen.map((n) => Math.max(0, (n.seenAt?.getTime() ?? 0) - n.createdAt.getTime())),
        ),
        acknowledged: input.events.filter((e) => e.type === "ACKNOWLEDGED" && e.userId === u.id)
          .length,
        resolved: claims.length,
        confirmed: claims.filter((c) => c.verdict === "CONFIRMED").length,
        rejected: claims.filter((c) => c.verdict === "REJECTED").length,
        pending: claims.filter((c) => c.verdict === null).length,
        accuracy: accuracyOf(claims),
        medianResolveMs: median(claims.map((c) => c.responseMs)),
      };
    })
    .filter((m) => m.received > 0 || m.acknowledged > 0 || m.resolved > 0)
    .sort((a, b) => b.resolved - a.resolved || b.received - a.received);
}

/** Problems raised vs closed per UTC day, oldest first, one entry per day of the period. */
export function dailySeries(alerts: MetricAlert[], from: Date, days: number) {
  const key = (d: Date) => d.toISOString().slice(0, 10);
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const rows = new Map<string, { date: string; raised: number; closed: number }>();
  for (let i = 0; i <= days; i++) {
    const date = key(new Date(start + i * 86_400_000));
    rows.set(date, { date, raised: 0, closed: 0 });
  }
  for (const a of alerts) {
    if (!a.actionable) continue;
    const r = rows.get(key(a.firstRaisedAt));
    if (r) r.raised++;
    if (a.closedAt) {
      const c = rows.get(key(a.closedAt));
      if (c) c.closed++;
    }
  }
  return [...rows.values()];
}

/** How far actionable alerts got: raised → seen → taken → fix reported → fix confirmed. */
export function funnel(alerts: MetricAlert[], claims: Claim[]) {
  const actionable = alerts.filter((a) => a.actionable);
  const claimed = new Set(claims.map((c) => c.alertId));
  return [
    { step: "Raised", count: actionable.length },
    { step: "Seen", count: actionable.filter((a) => a.firstSeenAt).length },
    {
      step: "Someone took it",
      count: actionable.filter((a) => a.acknowledgedAt || claimed.has(a.id)).length,
    },
    { step: "Fix reported", count: actionable.filter((a) => claimed.has(a.id)).length },
    { step: "Fix confirmed", count: actionable.filter((a) => a.status === "VERIFIED").length },
  ];
}
