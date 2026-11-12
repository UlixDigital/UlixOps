// CSP-safe SVG charts for the home Dashboard (A171). Plain attributes only — no inline styles.
import type { ExpiryBucket, StatTone } from "@/lib/dashboard";
import type { Severity } from "@ulixops/shared";
import { SEVERITY_ORDER } from "@ulixops/shared";

function Bar({
  pct,
  className,
  thin = false,
  label,
}: {
  pct: number;
  className: string;
  thin?: boolean;
  label: string;
}) {
  const h = thin ? 6 : 8;
  return (
    <svg width="100%" height={h} role="img" aria-label={label} className="block">
      <title>{label}</title>
      <rect width="100%" height={h} rx={h / 2} className="fill-muted" />
      {pct > 0 && (
        <rect width={`${Math.min(100, pct)}%`} height={h} rx={h / 2} className={className} />
      )}
    </svg>
  );
}

type Seg = { key: string; label: string; count: number; fill: string; swatch: string };

/** Horizontal stacked segments (fleet uptime, expiry buckets). */
export function SegmentBar({ segments, ariaLabel }: { segments: Seg[]; ariaLabel: string }) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  if (total === 0) return <p className="text-sm text-muted-foreground">No data yet.</p>;
  let x = 0;
  return (
    <div className="grid gap-2">
      <svg width="100%" height={12} role="img" aria-label={ariaLabel} className="block">
        <title>{ariaLabel}</title>
        <rect width="100%" height={12} rx={6} className="fill-muted" />
        {segments.map((seg) => {
          if (seg.count <= 0) return null;
          const w = (seg.count / total) * 100;
          const el = (
            <rect key={seg.key} x={`${x}%`} width={`${w}%`} height={12} className={seg.fill}>
              <title>{`${seg.label}: ${seg.count}`}</title>
            </rect>
          );
          x += w;
          return el;
        })}
      </svg>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {segments.map((seg) => (
          <li key={seg.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`inline-block size-2 rounded-sm ${seg.swatch}`} />
            {seg.label} <span className="tabular-nums text-foreground">{seg.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function uptimeSegments(counts: {
  up: number;
  down: number;
  paused: number;
  unknown: number;
}): Seg[] {
  return [
    {
      key: "up",
      label: "Up",
      count: counts.up,
      fill: "fill-success",
      swatch: "bg-success",
    },
    {
      key: "down",
      label: "Down",
      count: counts.down,
      fill: "fill-destructive",
      swatch: "bg-destructive",
    },
    {
      key: "paused",
      label: "Paused",
      count: counts.paused,
      fill: "fill-muted-foreground",
      swatch: "bg-muted-foreground",
    },
    {
      key: "unknown",
      label: "Unknown",
      count: counts.unknown,
      fill: "fill-border",
      swatch: "bg-border",
    },
  ];
}

export function expirySegments(buckets: Record<ExpiryBucket, number>): Seg[] {
  return [
    { key: "ok", label: "OK", count: buckets.ok, fill: "fill-success", swatch: "bg-success" },
    {
      key: "soon30",
      label: "≤ 30 days",
      count: buckets.soon30,
      fill: "fill-warning",
      swatch: "bg-warning",
    },
    {
      key: "soon7",
      label: "≤ 7 days",
      count: buckets.soon7,
      fill: "fill-destructive",
      swatch: "bg-destructive",
    },
    {
      key: "broken",
      label: "Broken / expired",
      count: buckets.broken,
      fill: "fill-destructive",
      swatch: "bg-destructive",
    },
  ];
}

const SEV_FILL: Record<Severity, { fill: string; swatch: string }> = {
  critical: { fill: "fill-destructive", swatch: "bg-destructive" },
  high: { fill: "fill-destructive", swatch: "bg-destructive" },
  medium: { fill: "fill-warning", swatch: "bg-warning" },
  low: { fill: "fill-primary", swatch: "bg-primary" },
  unknown: { fill: "fill-muted-foreground", swatch: "bg-muted-foreground" },
};

/** Severity breakdown as labeled horizontal bars. */
export function SeverityBars({ counts }: { counts: Record<Severity, number> }) {
  const max = Math.max(1, ...SEVERITY_ORDER.map((s) => counts[s]));
  const total = SEVERITY_ORDER.reduce((n, s) => n + counts[s], 0);
  if (total === 0) return <p className="text-sm text-muted-foreground">No open vulnerabilities.</p>;
  return (
    <ol className="grid gap-2">
      {SEVERITY_ORDER.map((level) => {
        const n = counts[level];
        const pct = Math.round((n / max) * 100);
        return (
          <li key={level} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 capitalize">
                <span
                  aria-hidden
                  className={`inline-block size-2 rounded-sm ${SEV_FILL[level].swatch}`}
                />
                {level}
              </span>
              <span className="font-medium tabular-nums">{n}</span>
            </div>
            <Bar
              pct={n === 0 ? 0 : Math.max(4, pct)}
              className={SEV_FILL[level].fill}
              label={`${level}: ${n}`}
            />
          </li>
        );
      })}
    </ol>
  );
}

/** Simple proportion meter (clean vs problem). */
export function StatMeter({
  value,
  total,
  label,
  tone,
}: {
  value: number;
  total: number;
  label: string;
  tone: StatTone;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const fill =
    tone === "bad" ? "fill-destructive" : tone === "warn" ? "fill-warning" : "fill-success";
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="tabular-nums">
          <span className="font-medium">{value}</span>
          <span className="text-xs text-muted-foreground"> / {total}</span>
        </span>
      </div>
      <Bar pct={pct} className={fill} label={`${label}: ${value} of ${total}`} thin />
    </div>
  );
}

const RING_STROKE: Record<StatTone, string> = {
  neutral: "stroke-muted-foreground",
  ok: "stroke-success",
  warn: "stroke-warning",
  bad: "stroke-destructive",
};

/** Big number inside a progress ring — fills empty panels without a wall of text. */
export function RingStat({
  value,
  total,
  label,
  hint,
  tone = "neutral",
}: {
  value: number;
  total: number;
  label: string;
  hint?: string;
  tone?: StatTone;
}) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? Math.min(1, value / total) : 0;
  const dash = Math.max(pct > 0 ? 4 : 0, pct * c);
  return (
    <div className="flex items-center gap-4">
      <svg
        width={88}
        height={88}
        viewBox="0 0 88 88"
        role="img"
        aria-label={`${label}: ${value}${total > 0 ? ` of ${total}` : ""}`}
        className="shrink-0"
      >
        <title>{`${label}: ${value}${total > 0 ? ` of ${total}` : ""}`}</title>
        <circle cx="44" cy="44" r={r} className="fill-none stroke-muted" strokeWidth="8" />
        {dash > 0 && (
          <circle
            cx="44"
            cy="44"
            r={r}
            className={`fill-none ${RING_STROKE[tone]}`}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
            transform="rotate(-90 44 44)"
          />
        )}
        <text
          x="44"
          y="50"
          textAnchor="middle"
          className="fill-foreground font-semibold"
          fontSize="22"
        >
          {value}
        </text>
      </svg>
      <div className="min-w-0 grid gap-0.5">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

/** Named counts as horizontal bars (deployments, alerts, audit categories). */
export function CountBars({
  rows,
  ariaLabel,
}: {
  rows: { key: string; label: string; count: number; tone?: StatTone }[];
  ariaLabel: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const total = rows.reduce((n, r) => n + r.count, 0);
  if (total === 0) return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
  return (
    <ol className="grid gap-2" aria-label={ariaLabel}>
      {rows.map((row) => {
        const tone = row.tone ?? "neutral";
        const fill =
          tone === "bad"
            ? "fill-destructive"
            : tone === "warn"
              ? "fill-warning"
              : tone === "ok"
                ? "fill-success"
                : "fill-primary";
        const pct = Math.round((row.count / max) * 100);
        return (
          <li key={row.key} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate">{row.label}</span>
              <span className="font-medium tabular-nums">{row.count}</span>
            </div>
            <Bar
              pct={row.count === 0 ? 0 : Math.max(4, pct)}
              className={fill}
              label={`${row.label}: ${row.count}`}
              thin
            />
          </li>
        );
      })}
    </ol>
  );
}
