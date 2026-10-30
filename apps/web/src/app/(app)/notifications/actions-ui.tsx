"use client";
import { useActionState } from "react";
import type { ActionState } from "@/components/action-form";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { markAllReadAction, markReadAction } from "./actions";

export function MarkReadButton({ id }: { id: string }) {
  const [, action] = useActionState<ActionState, FormData>(markReadAction, {});
  return (
    <form action={action}>
      <FormPendingOverlay label="Updating…" />
      <input type="hidden" name="id" value={id} />
      <PendingSubmit variant="outline" size="sm" pendingLabel="…">
        Mark read
      </PendingSubmit>
    </form>
  );
}

export function MarkAllRead() {
  const [, action] = useActionState<ActionState, FormData>(markAllReadAction, {});
  return (
    <form action={action}>
      <FormPendingOverlay label="Updating…" />
      <PendingSubmit variant="outline" size="sm" pendingLabel="…">
        Mark all read
      </PendingSubmit>
    </form>
  );
}
