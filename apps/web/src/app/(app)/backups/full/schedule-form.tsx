"use client";
// Weekly backup schedule (A145). Times are UTC; the hint shows the viewer's local time.
import { type BackupSchedule, WEEKDAYS } from "@ulixops/shared";
import { useEffect, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { hourLabel } from "@/lib/malware";
import { saveBackupScheduleAction } from "./actions";

export function LocalStart({ day, hour }: { day: number; hour: number }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((day - d.getUTCDay() + 7) % 7));
    d.setUTCHours(hour, 0, 0, 0);
    setText(
      `Your time: ${d.toLocaleDateString([], { weekday: "long" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    );
  }, [day, hour]);
  return text ? <span>{text}</span> : null;
}

export function BackupScheduleForm({ value }: { value: BackupSchedule }) {
  const [day, setDay] = useState(value.dayOfWeek);
  const [hour, setHour] = useState(value.startHourUtc);
  return (
    <ActionForm action={saveBackupScheduleAction} submitLabel="Save schedule">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={value.enabled}
            className="mt-1 size-4 rounded border border-input"
          />
          <span>
            <span className="font-medium">Back up every site weekly</span>
            <span className="block text-xs text-muted-foreground">
              One site at a time. Each site is checked first; an unhealthy site is skipped and its
              last backup kept. After a verified new backup, last week&apos;s is deleted from Drive
              (not to Trash).
            </span>
          </span>
        </label>
        <div className="grid gap-1.5">
          <Label htmlFor="dayOfWeek">Day</Label>
          <Select
            id="dayOfWeek"
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
          <Label htmlFor="startHourUtc">Start at (UTC)</Label>
          <Select
            id="startHourUtc"
            name="startHourUtc"
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
        <div className="grid gap-1.5">
          <Label htmlFor="windowHours">Start new backups for</Label>
          <Select id="windowHours" name="windowHours" defaultValue={value.windowHours}>
            {[4, 6, 8, 12, 24].map((h) => (
              <option key={h} value={h}>
                {h} hours
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            A backup that starts in time may finish later.
          </p>
        </div>
        <label className="flex items-start gap-2 self-center text-sm">
          <input
            type="checkbox"
            name="includeStaging"
            defaultChecked={value.includeStaging}
            className="mt-1 size-4 rounded border border-input"
          />
          <span>Include staging environments</span>
        </label>
      </div>
    </ActionForm>
  );
}
