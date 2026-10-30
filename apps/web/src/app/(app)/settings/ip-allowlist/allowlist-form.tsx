"use client";
import { useActionState, useState } from "react";
import type { ActionState } from "@/components/action-form";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { saveAllowlistAction } from "../actions";

export function AllowlistForm({
  enabled,
  entries,
  currentIp,
}: {
  enabled: boolean;
  entries: string;
  currentIp: string | null;
}) {
  const [state, action] = useActionState<ActionState, FormData>(saveAllowlistAction, {});
  const [text, setText] = useState(entries);
  const hasCurrent =
    currentIp !== null &&
    text.split("\n").some((line) => line.trim().split(/\s+/)[0] === currentIp);

  return (
    <form action={action} className="grid gap-4">
      <FormPendingOverlay label="Saving allowlist…" />
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={enabled}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          <span className="font-medium">Only allow these addresses</span>
          <span className="block text-muted-foreground">
            Everyone else gets "access not allowed" before they even see the sign-in page.
          </span>
        </span>
      </label>
      <div className="grid gap-1.5">
        <Label htmlFor="entries">Allowed addresses</Label>
        <textarea
          id="entries"
          name="entries"
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          placeholder={"203.0.113.0/24  Office\n198.51.100.7  VPN"}
          aria-describedby="entries-hint"
          className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm placeholder:text-muted-foreground"
        />
        <p id="entries-hint" className="text-xs text-muted-foreground">
          One per line: an IP address or a CIDR range (IPv4 or IPv6), then an optional label.
        </p>
      </div>
      {currentIp && !hasCurrent && (
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setText((t) => `${t.trimEnd()}\n${currentIp}  My current IP`.trimStart())
            }
          >
            Add my current IP ({currentIp})
          </Button>
        </div>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div>
        <PendingSubmit pendingLabel="Saving…">Save allowlist</PendingSubmit>
      </div>
    </form>
  );
}
