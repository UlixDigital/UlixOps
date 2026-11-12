"use client";
// Alert follow-up controls on the Notifications page (A158).
import {
  ALERT_RESOLUTION_LABELS,
  AlertResolution,
  FIX_ACTION_LABELS,
  FixAction,
} from "@ulixops/shared";
import { useActionState, useEffect, useId, useRef } from "react";
import type { ActionState } from "@/components/action-form";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { acknowledgeAlertAction, markSeenAction, resolveAlertAction } from "./actions";

/** Counts the listed notifications as seen once the page is actually shown. */
export function MarkSeenOnView({ ids }: { ids: string[] }) {
  const key = ids.join(",");
  useEffect(() => {
    if (!key) return;
    const send = () => {
      if (document.visibilityState !== "visible") return false;
      void markSeenAction(key.split(","));
      return true;
    };
    if (send()) return;
    const onVisible = () => {
      if (send()) document.removeEventListener("visibilitychange", onVisible);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [key]);
  return null;
}

export function TakeAlertButton({ alertId, takeOver }: { alertId: string; takeOver: boolean }) {
  const [state, action] = useActionState<ActionState, FormData>(acknowledgeAlertAction, {});
  return (
    <form action={action} className="grid gap-1">
      <FormPendingOverlay label="Updating…" />
      <input type="hidden" name="alertId" value={alertId} />
      <PendingSubmit size="sm" pendingLabel="…">
        {takeOver ? "Take over" : "I'm on it"}
      </PendingSubmit>
      {state.error && <p className="text-xs text-destructive">{state.error}</p>}
    </form>
  );
}

const FIX_ACTIONS = FixAction.options.filter((a) => a !== "approval_decided");

export function ResolveAlertDialog({
  alertId,
  title,
  autoVerify,
}: {
  alertId: string;
  title: string;
  autoVerify: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(resolveAlertAction, {});
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const submitted = useRef(false);
  // Close once the action succeeded (no error came back).
  useEffect(() => {
    if (submitted.current && !state.error) dialog.current?.close();
  }, [state]);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => dialog.current?.showModal()}>
        Report fix
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="mx-auto mt-[12vh] w-[min(32rem,calc(100vw-2rem))] rounded-lg border bg-popover p-6 text-popover-foreground shadow-sm backdrop:bg-black/40"
      >
        <form
          action={action}
          onSubmit={() => {
            submitted.current = true;
          }}
          className="grid gap-4"
        >
          <FormPendingOverlay label="Saving…" />
          <input type="hidden" name="alertId" value={alertId} />
          <div>
            <h2 id={titleId} className="text-base font-semibold">
              Report the fix
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{title}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${titleId}-resolution`}>Outcome</Label>
            <Select id={`${titleId}-resolution`} name="resolution" defaultValue="FIXED" required>
              {AlertResolution.options.map((r) => (
                <option key={r} value={r}>
                  {ALERT_RESOLUTION_LABELS[r]}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${titleId}-fix`}>What did you do?</Label>
            <Select id={`${titleId}-fix`} name="fixAction" defaultValue="" required>
              <option value="" disabled>
                Choose one…
              </option>
              {FIX_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {FIX_ACTION_LABELS[a]}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${titleId}-note`}>Details</Label>
            <textarea
              id={`${titleId}-note`}
              name="note"
              required
              minLength={10}
              maxLength={2000}
              rows={4}
              placeholder="Which files, versions or settings you changed, and how you checked it works."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {autoVerify
              ? "UlixOps checks this again by itself. If the next check still finds the problem, the alert reopens and the fix counts as not working."
              : "A Super Admin confirms the fix. If it didn't work, they reopen the alert."}
          </p>
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <PendingSubmit pendingLabel="Saving…">Report fix</PendingSubmit>
          </div>
        </form>
      </dialog>
    </>
  );
}
