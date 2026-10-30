"use client";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** Asymptotic estimate: climbs toward 99% while the server action is still pending (A101). */
function estimatePercent(elapsedMs: number, expectedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.min(99, Math.round(100 * (1 - Math.exp(-elapsedMs / expectedMs))));
}

function ProgressRing({ percent, label }: { percent: number; label: string }) {
  const size = 56;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - percent / 100);
  return (
    <div className="relative size-14" role="progressbar" aria-valuenow={percent} aria-label={label}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="text-primary transition-[stroke-dashoffset] duration-200"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums">
        {percent}%
      </span>
    </div>
  );
}

/**
 * Full-screen popup with an estimated percentage while a long action runs.
 * The % is time-based (not byte progress): site jobs finish in one server-action wait (A101).
 */
export function BusyOverlay({
  pending,
  label = "Working…",
  expectedMs = 30_000,
  showPercent = true,
}: {
  pending: boolean;
  label?: string;
  /** Typical duration used for the asymptotic estimate. */
  expectedMs?: number;
  /** Passkeys / short waits can hide the fake %. */
  showPercent?: boolean;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!pending || !showPercent) {
      setElapsedMs(0);
      return;
    }
    const started = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => setElapsedMs(Date.now() - started), 200);
    return () => window.clearInterval(id);
  }, [pending, showPercent]);

  if (!pending) return null;
  const percent = showPercent ? estimatePercent(elapsedMs, expectedMs) : null;
  return (
    <div
      role="alert"
      aria-busy="true"
      aria-live="assertive"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-[1px]"
    >
      <div className="flex min-w-[12rem] flex-col items-center gap-3 rounded-lg border bg-popover px-8 py-6 text-popover-foreground shadow-sm">
        {percent !== null ? (
          <ProgressRing percent={percent} label={label} />
        ) : (
          <Spinner className="size-10" label={label} />
        )}
        <p className="text-sm font-medium">
          {label}
          {percent !== null ? (
            <span className="ml-1 tabular-nums text-muted-foreground">{percent}%</span>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/**
 * Shows BusyOverlay while the parent form is submitting (useFormStatus).
 * Place inside any `<form>`.
 */
export function FormPendingOverlay({
  label = "Working…",
  expectedMs,
  showPercent,
}: {
  label?: string;
  expectedMs?: number;
  showPercent?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <BusyOverlay
      pending={pending}
      label={label}
      expectedMs={expectedMs}
      showPercent={showPercent}
    />
  );
}

/** Submit button that shows a spinner while the form is pending. */
export function PendingSubmit({
  children,
  pendingLabel = "Working…",
  className,
  variant,
  size,
  ...props
}: {
  children: ReactNode;
  pendingLabel?: string;
} & ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending || props.disabled}
      variant={variant}
      size={size}
      className={cn(className)}
      aria-busy={pending}
      {...props}
    >
      {pending ? (
        <>
          <Spinner className="size-4" />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
}
