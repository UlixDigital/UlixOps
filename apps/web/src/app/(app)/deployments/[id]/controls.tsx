"use client";
import type { DeploymentView } from "@ulixops/shared";
import { useActionState } from "react";
import type { ActionState } from "@/components/action-form";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { cancelDeploymentAction, pauseDeploymentAction, resumeDeploymentAction } from "../actions";

export function DeploymentControls({ deployment }: { deployment: DeploymentView }) {
  const [pauseState, pause] = useActionState<ActionState, FormData>(pauseDeploymentAction, {});
  const [resumeState, resume] = useActionState<ActionState, FormData>(resumeDeploymentAction, {});
  const [cancelState, cancel] = useActionState<ActionState, FormData>(cancelDeploymentAction, {});
  const error = pauseState.error ?? resumeState.error ?? cancelState.error;
  const { status, id } = deployment;

  if (!["QUEUED", "RUNNING", "PAUSED", "PENDING_APPROVAL"].includes(status)) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {(status === "QUEUED" || status === "RUNNING") && (
        <form action={pause}>
          <FormPendingOverlay label="Pausing deployment…" />
          <input type="hidden" name="id" value={id} />
          <PendingSubmit variant="outline" size="sm" pendingLabel="Working…">
            Pause
          </PendingSubmit>
        </form>
      )}
      {status === "PAUSED" && (
        <form action={resume}>
          <FormPendingOverlay label="Resuming deployment…" />
          <input type="hidden" name="id" value={id} />
          <PendingSubmit size="sm" pendingLabel="Working…">
            Resume
          </PendingSubmit>
        </form>
      )}
      <form action={cancel}>
        <FormPendingOverlay label="Cancelling deployment…" />
        <input type="hidden" name="id" value={id} />
        <PendingSubmit variant="outline" size="sm" pendingLabel="Working…">
          Cancel
        </PendingSubmit>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
