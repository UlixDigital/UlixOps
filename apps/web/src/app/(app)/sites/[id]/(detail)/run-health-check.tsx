"use client";

import type { EnvKind } from "@ulixops/shared";
import { useActionState } from "react";
import type { ActionState } from "@/components/action-form";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { runHealthCheckAction } from "../../actions";

export function RunHealthCheck({ siteId, kind }: { siteId: string; kind: EnvKind }) {
  const [state, action] = useActionState<ActionState, FormData>(runHealthCheckAction, {});
  return (
    <form action={action} className="grid gap-2">
      <FormPendingOverlay label="Running health check…" />
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="kind" value={kind} />
      <div>
        <PendingSubmit variant="outline" pendingLabel="Checking…">
          Run health check
        </PendingSubmit>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
