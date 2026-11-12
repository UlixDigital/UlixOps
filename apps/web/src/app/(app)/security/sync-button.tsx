"use client";

import { ActionForm } from "@/components/action-form";
import { syncVulnerabilitiesAction } from "./actions";

export function SyncButton() {
  return (
    <ActionForm
      action={syncVulnerabilitiesAction}
      submitLabel="Sync feed now"
      variant="outline"
      pendingLabel="Starting sync…"
    />
  );
}
