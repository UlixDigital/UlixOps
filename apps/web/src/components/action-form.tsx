"use client";
import { type ReactNode, useActionState, useId, useRef } from "react";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ActionState {
  error?: string;
  /** A value to show once, e.g. a freshly issued setup link or a new public key. */
  link?: string;
}

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

// Outlined, not filled: keeps AA contrast in both themes and the palette muted.
const DESTRUCTIVE =
  "border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive";

/**
 * A form bound to a Server Action that shows its error inline. With `confirm`, the button
 * first opens a confirmation dialog (spec: destructive actions need one).
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  variant,
  confirm,
  className,
  linkNote,
  linkLabel = "Setup link",
  pendingLabel = "Working…",
  expectedMs,
}: {
  action: Action;
  children?: ReactNode;
  submitLabel: string;
  variant?: "default" | "outline" | "destructive";
  confirm?: { title: string; description: string };
  className?: string;
  /** Shown above a link the action returns (e.g. a setup link), with a copy button. */
  linkNote?: string;
  /** Accessible name of the field showing that value. */
  linkLabel?: string;
  /** Label on the circular progress popup while the action runs. */
  pendingLabel?: string;
  /** Typical duration for the overlay's estimated % (A101). */
  expectedMs?: number;
}) {
  const [state, formAction] = useActionState(action, {});
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <form
      action={formAction}
      className={cn("grid gap-3", className)}
      onSubmit={() => dialog.current?.close()}
    >
      <FormPendingOverlay label={pendingLabel} expectedMs={expectedMs} />
      {children}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.link && <CopyField value={state.link} note={linkNote ?? ""} label={linkLabel} />}
      <div>
        {confirm ? (
          <>
            <Button
              type="button"
              variant={variant === "destructive" ? "outline" : variant}
              className={cn(variant === "destructive" && DESTRUCTIVE)}
              onClick={() => dialog.current?.showModal()}
            >
              {submitLabel}
            </Button>
            <dialog
              ref={dialog}
              aria-labelledby={titleId}
              className="mx-auto mt-[20vh] w-[min(28rem,calc(100vw-2rem))] rounded-lg border bg-popover p-6 text-popover-foreground shadow-sm backdrop:bg-black/40"
            >
              <h2 id={titleId} className="text-base font-semibold">
                {confirm.title}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">{confirm.description}</p>
              <div className="mt-6 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => dialog.current?.close()}>
                  Cancel
                </Button>
                <PendingSubmit
                  pendingLabel={pendingLabel}
                  variant={variant === "destructive" ? "outline" : variant}
                  className={cn(variant === "destructive" && DESTRUCTIVE)}
                >
                  {submitLabel}
                </PendingSubmit>
              </div>
            </dialog>
          </>
        ) : (
          <PendingSubmit
            pendingLabel={pendingLabel}
            variant={variant === "destructive" ? "outline" : variant}
            className={cn(variant === "destructive" && DESTRUCTIVE)}
          >
            {submitLabel}
          </PendingSubmit>
        )}
      </div>
    </form>
  );
}

export function CopyField({
  value,
  note,
  label = "Setup link",
}: {
  value: string;
  note: string;
  label?: string;
}) {
  return (
    <div className="grid gap-2 rounded-md border bg-muted/40 p-3">
      <p className="text-sm">{note}</p>
      <div className="flex gap-2">
        <input
          readOnly
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="h-9 flex-1 rounded-md border bg-background px-3 font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void navigator.clipboard.writeText(value)}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
