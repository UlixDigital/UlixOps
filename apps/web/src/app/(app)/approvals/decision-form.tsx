"use client";
import { useActionState, useId, useRef } from "react";
import type { ActionState } from "@/components/action-form";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { Button } from "@/components/ui/button";
import { decideApprovalAction } from "./actions";

/** Approve (after a confirmation) or reject, with an optional comment kept in the audit log. */
export function DecisionForm({
  requestId,
  summary,
  bulkUpdate = false,
}: {
  requestId: string;
  summary: string;
  /** site.bulk_update: approve returns immediately; the run continues in the background (A108). */
  bulkUpdate?: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(decideApprovalAction, {});
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const commentId = useId();
  return (
    <form action={action} className="grid gap-2" onSubmit={() => dialog.current?.close()}>
      <FormPendingOverlay label="Saving decision…" />
      <input type="hidden" name="requestId" value={requestId} />
      {bulkUpdate && <input type="hidden" name="bulkUpdate" value="1" />}
      <label htmlFor={commentId} className="sr-only">
        Comment
      </label>
      <textarea
        id={commentId}
        name="comment"
        rows={2}
        maxLength={500}
        placeholder="Comment (optional, kept in the audit log)"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
      />
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => dialog.current?.showModal()}>
          Approve
        </Button>
        <PendingSubmit name="decision" value="reject" variant="outline" pendingLabel="Working…">
          Reject
        </PendingSubmit>
      </div>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="mx-auto mt-[20vh] w-[min(28rem,calc(100vw-2rem))] rounded-lg border bg-popover p-6 text-popover-foreground shadow-sm backdrop:bg-black/40"
      >
        <h2 id={titleId} className="text-base font-semibold">
          Approve this change?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{summary}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {bulkUpdate
            ? "Only the listed items run. Progress shows on the site's Plugins page (snapshot → update → health, with auto-rollback on breakage). You and the requester are notified when it finishes or fails."
            : "It is applied straight away."}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
          <PendingSubmit name="decision" value="approve" pendingLabel="Working…">
            Approve
          </PendingSubmit>
        </div>
      </dialog>
    </form>
  );
}
