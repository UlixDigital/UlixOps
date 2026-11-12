"use client";

import type { HealthCheckSettings } from "@ulixops/shared";
import {
  BUILTIN_HEALTH_PATHS,
  MAX_HEALTH_THRESHOLD_MS,
  MIN_HEALTH_THRESHOLD_MS,
} from "@ulixops/shared";
import { ActionForm } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveHealthCheckAction } from "./health-actions";

export function HealthCheckForm({ value }: { value: HealthCheckSettings }) {
  return (
    <ActionForm action={saveHealthCheckAction} submitLabel="Save health checks">
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="health-extra-paths">Extra paths (one per line)</Label>
          <textarea
            id="health-extra-paths"
            name="extraPaths"
            rows={4}
            defaultValue={value.extraPaths.join("\n")}
            placeholder={"/shop/\n/contact/"}
            className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <p className="text-xs text-muted-foreground">
            Always checked: the homepage ({BUILTIN_HEALTH_PATHS.join(", ")}). Add more paths under
            the site origin (each must start with /).
          </p>
        </div>
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="health-threshold">Response-time threshold (ms)</Label>
          <Input
            id="health-threshold"
            name="thresholdMs"
            type="number"
            min={MIN_HEALTH_THRESHOLD_MS}
            max={MAX_HEALTH_THRESHOLD_MS}
            step={100}
            defaultValue={value.thresholdMs}
            required
          />
          <p className="text-xs text-muted-foreground">
            Fail a URL when it takes longer than this ({MIN_HEALTH_THRESHOLD_MS}–
            {MAX_HEALTH_THRESHOLD_MS} ms).
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="checkWpAdmin"
            defaultChecked={value.checkWpAdmin}
            className="mt-1 size-4 rounded border border-input"
          />
          <span>
            Also check <span className="font-mono text-xs">/wp-admin/</span> (off by default: sites
            with login bot protection block the hub&apos;s server and would show as unhealthy, and
            updates would be rolled back)
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="checkErrorLog"
            defaultChecked={value.checkErrorLog}
            className="mt-1 size-4 rounded border border-input"
          />
          <span>
            Check <span className="font-mono text-xs">wp-content/debug.log</span> for recent
            fatal/parse lines (skipped when the file is missing)
          </span>
        </label>
      </div>
    </ActionForm>
  );
}
