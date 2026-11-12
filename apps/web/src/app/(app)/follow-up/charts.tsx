// Small server-rendered charts for the alert follow-up report (A158). Single accent colour,
// thin marks, recessive axes; every mark has a native hover tooltip and the numbers are also
// printed or in a table next to it.
import type { AlertTrackingReport } from "@ulixops/shared";

/**
 * A horizontal bar drawn in SVG: plain attributes instead of an inline style, which the
 * production CSP (nonce-only styles) would block.
 */
function Bar({
  pct,
  className,
  thin = false,
  children,
}: {
  pct: number;
  className: string;
  thin?: boolean;
  children: string;
}) {
  const h = thin ? 6 : 8;
  return (
    <svg width="100%" height={h} role="img" aria-label={children} className="block">
      <title>{children}</title>
      <rect width="100%" height={h} rx={h / 2} className="fill-muted" />
      {pct > 0 && <rect width={`${pct}%`} height={h} rx={h / 2} className={className} />}
    </svg>
  );
}

/** How far alerts got through the follow-up steps, as share of all raised. */
export function FunnelChart({ steps }: { steps: AlertTrackingReport["funnel"] }) {
  const top = steps[0]?.count ?? 0;
  return (
    <ol className="grid gap-2.5">
      {steps.map((s, i) => {
        const pct = top ? Math.round((s.count / top) * 100) : 0;
        const prev = i > 0 ? (steps[i - 1]?.count ?? 0) : null;
        const lost = prev !== null ? prev - s.count : 0;
        return (
          <li key={s.step} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span>
                <span className="mr-1.5 text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                {s.step}
              </span>
              <span className="tabular-nums">
                <span className="font-medium">{s.count}</span>
                <span className="text-xs text-muted-foreground"> · {pct}%</span>
              </span>
            </div>
            <Bar pct={pct} className="fill-primary">
              {`${s.step}: ${s.count} of ${top} (${pct}%)${lost > 0 ? `, ${lost} stopped before this step` : ""}`}
            </Bar>
          </li>
        );
      })}
    </ol>
  );
}

/** Problems raised (columns) and closed (line) per day. */
export function DailyChart({ days }: { days: AlertTrackingReport["daily"] }) {
  const W = 640;
  const H = 180;
  const PAD = { top: 10, right: 8, bottom: 22, left: 28 };
  const max = Math.max(1, ...days.flatMap((d) => [d.raised, d.closed]));
  const ticks =
    max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, Math.ceil(max / 2), max];
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(18, step - 2));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const x = (i: number) => PAD.left + i * step + step / 2;
  const line = days
    .map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.closed).toFixed(1)}`)
    .join(" ");
  const labelEvery = Math.ceil(days.length / 6);
  const short = (date: string) => date.slice(5).replace("-", "/");

  return (
    <figure className="grid gap-2">
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-sm bg-primary" /> Raised
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-3 rounded bg-foreground" /> Closed
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Alerts raised and closed per day, ${days.length} days`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {t}
            </text>
          </g>
        ))}
        {days.map((d, i) => (
          <g key={d.date}>
            {/* Full-height hit target for the tooltip. */}
            <rect
              x={x(i) - step / 2}
              y={PAD.top}
              width={step}
              height={plotH}
              className="fill-transparent"
            >
              <title>{`${d.date}: ${d.raised} raised, ${d.closed} closed`}</title>
            </rect>
            {d.raised > 0 && (
              <rect
                x={x(i) - barW / 2}
                y={y(d.raised)}
                width={barW}
                height={Math.max(1, y(0) - y(d.raised))}
                rx={Math.min(3, barW / 2)}
                className="pointer-events-none fill-primary"
              />
            )}
            {i % labelEvery === 0 && (
              <text
                x={x(i)}
                y={H - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {short(d.date)}
              </text>
            )}
          </g>
        ))}
        <path
          d={line}
          fill="none"
          strokeWidth={2}
          strokeLinejoin="round"
          className="pointer-events-none stroke-foreground"
        />
      </svg>
    </figure>
  );
}

/** A 0–100 % meter with the value printed beside it. */
export function Meter({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
  const pct = Math.round(value * 100);
  return (
    <span className="inline-flex items-center gap-2" title={`${label}: ${pct}%`}>
      <span className="w-14">
        <Bar
          pct={pct}
          thin
          className={pct >= 80 ? "fill-success" : pct >= 50 ? "fill-warning" : "fill-destructive"}
        >
          {`${label}: ${pct}%`}
        </Bar>
      </span>
      <span className="text-sm tabular-nums">{pct}%</span>
    </span>
  );
}
