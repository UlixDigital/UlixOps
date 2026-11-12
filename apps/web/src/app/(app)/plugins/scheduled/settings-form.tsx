"use client";
// Scheduled updates window and skip list for one site (A162). Times are UTC.
import { type AutoUpdateSkip, type AutoUpdateWindow, WEEKDAYS } from "@ulixops/shared";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { hourLabel } from "@/lib/malware";
import { LocalStart } from "../../backups/full/schedule-form";
import { saveAutoUpdateSettingsAction } from "./actions";

export function AutoUpdateSettingsForm({
  siteId,
  window,
  skip,
  installed,
}: {
  siteId: string;
  window: AutoUpdateWindow;
  skip: AutoUpdateSkip[];
  /** Plugins and themes to choose from (installed, plus anything already skipped). */
  installed: AutoUpdateSkip[];
}) {
  const [day, setDay] = useState(window.dayOfWeek);
  const [hour, setHour] = useState(window.hourUtc);
  const skipped = new Set(skip.map((s) => `${s.asset}:${s.name}`));
  const choices = [
    ...installed,
    ...skip.filter((s) => !installed.some((i) => i.asset === s.asset && i.name === s.name)),
  ].sort((a, b) => a.asset.localeCompare(b.asset) || a.name.localeCompare(b.name));
  return (
    <ActionForm action={saveAutoUpdateSettingsAction} submitLabel="Save" variant="outline">
      <input type="hidden" name="siteId" value={siteId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="au-day">Day</Label>
          <Select
            id="au-day"
            name="dayOfWeek"
            value={day}
            onChange={(e) => setDay(Number(e.target.value))}
          >
            {WEEKDAYS.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="au-hour">Start at (UTC)</Label>
          <Select
            id="au-hour"
            name="hourUtc"
            value={hour}
            onChange={(e) => setHour(Number(e.target.value))}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hourLabel(h)} UTC
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            <LocalStart day={day} hour={hour} />
          </p>
        </div>
      </div>
      {choices.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Never update automatically</legend>
          <p className="text-xs text-muted-foreground">
            Ticked plugins and themes are left for a manual update.
          </p>
          <div className="grid max-h-64 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
            {choices.map((c) => {
              const key = `${c.asset}:${c.name}`;
              return (
                <label key={key} className="flex min-w-0 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="skip"
                    value={key}
                    defaultChecked={skipped.has(key)}
                    className="size-4 shrink-0 rounded border border-input"
                  />
                  <span className="truncate font-mono text-xs" title={c.name}>
                    {c.name}
                  </span>
                  {c.asset === "theme" && (
                    <span className="text-[11px] text-muted-foreground">theme</span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
    </ActionForm>
  );
}
