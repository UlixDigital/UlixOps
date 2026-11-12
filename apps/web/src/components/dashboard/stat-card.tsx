import Link from "next/link";
import type { StatTone } from "@/lib/dashboard";
import { cn } from "@/lib/utils";

const TONE: Record<StatTone, string> = {
  neutral: "",
  ok: "border-success/30 bg-success/5",
  warn: "border-warning/40 bg-warning/5",
  bad: "border-destructive/40 bg-destructive/5",
};

const VALUE: Record<StatTone, string> = {
  neutral: "",
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
};

/** One KPI on the dashboard strip; optional link to the detail screen. */
export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  href,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: StatTone;
  href?: string;
}) {
  const inner = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular-nums", VALUE[tone])}>
        {value}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
    </>
  );
  const className = cn("block rounded-lg border bg-card p-4 shadow-sm", TONE[tone]);
  if (href)
    return (
      <Link href={href} className={cn(className, "transition-colors hover:bg-muted/40")}>
        {inner}
      </Link>
    );
  return <div className={className}>{inner}</div>;
}
