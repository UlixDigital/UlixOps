"use client";

import type { VisualCheckSettings } from "@ulixops/shared";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { saveVisualSettingsAction } from "./actions";

export function VisualSettingsForm({ settings }: { settings: VisualCheckSettings }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [maxDiff, setMaxDiff] = useState(String(settings.maxDiffPercent));
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Card className="grid gap-3 p-4">
      <div>
        <h2 className="text-sm font-medium">Settings</h2>
        <p className="text-xs text-muted-foreground">
          Pages come from the health-check list (homepage + Settings → Health checks extra paths).
          Diffs never roll back a deploy — they only alert.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-4 rounded border"
        />
        Run automatically on deploys and updates
      </label>
      <label className="grid max-w-xs gap-1 text-sm">
        <span className="text-muted-foreground">
          Flag a page when more than this % of pixels change
        </span>
        <input
          type="number"
          min={0.01}
          max={50}
          step={0.1}
          value={maxDiff}
          onChange={(e) => setMaxDiff(e.target.value)}
          className="rounded-md border bg-background px-2 py-1.5"
        />
      </label>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            start(async () => {
              const n = Number(maxDiff);
              const res = await saveVisualSettingsAction({
                ...settings,
                enabled,
                maxDiffPercent: Number.isFinite(n) ? n : settings.maxDiffPercent,
              });
              setMessage(res.ok ? "Saved." : res.error);
            });
          }}
        >
          Save
        </Button>
        {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
      </div>
    </Card>
  );
}
