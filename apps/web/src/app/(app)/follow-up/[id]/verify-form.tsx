"use client";
import { useActionState } from "react";
import type { ActionState } from "@/components/action-form";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { Label } from "@/components/ui/label";
import { verifyAlertAction } from "../actions";

/** Confirm / reject a reported fix (RESOLVED), or reopen a closed alert. */
export function VerifyForm({ alertId, mode }: { alertId: string; mode: "verify" | "reopen" }) {
  const [state, action] = useActionState<ActionState, FormData>(verifyAlertAction, {});
  return (
    <form action={action} className="grid gap-3">
      <FormPendingOverlay label="Saving…" />
      <input type="hidden" name="alertId" value={alertId} />
      <div className="grid gap-1.5">
        <Label htmlFor={`verify-note-${alertId}`}>
          {mode === "verify" ? "What did you check?" : "Why reopen it?"}
        </Label>
        <textarea
          id={`verify-note-${alertId}`}
          name="note"
          required
          minLength={3}
          maxLength={1000}
          rows={3}
          placeholder={
            mode === "verify"
              ? "e.g. Re-ran the scan / opened the site / checked the plugin version."
              : "e.g. The same file is back after the fix."
          }
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {mode === "verify" ? (
          <>
            <PendingSubmit name="outcome" value="CONFIRMED" pendingLabel="Saving…">
              Confirm the fix
            </PendingSubmit>
            <PendingSubmit
              name="outcome"
              value="REJECTED"
              variant="outline"
              pendingLabel="Saving…"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Not fixed: reopen
            </PendingSubmit>
          </>
        ) : (
          <PendingSubmit name="outcome" value="REOPEN" variant="outline" pendingLabel="Saving…">
            Reopen the alert
          </PendingSubmit>
        )}
      </div>
    </form>
  );
}
