"use client";

import { ActionForm } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveRetentionAction } from "./retention-actions";

export function RetentionForm({ days }: { days: number }) {
  return (
    <ActionForm action={saveRetentionAction} submitLabel="Save retention">
      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor="retention-days">Keep quick snapshots for (days)</Label>
        <Input
          id="retention-days"
          name="days"
          type="number"
          min={1}
          max={90}
          defaultValue={days}
          required
        />
        <p className="text-xs text-muted-foreground">Between 1 and 90 days. Default is 7.</p>
      </div>
    </ActionForm>
  );
}
