"use client";
// "Test connection" (spec screen 4): vault → SSH → WP-CLI → WordPress, run by the runner.
import type { EnvKind } from "@ulixops/shared";
import { CircleCheck, CircleX } from "lucide-react";
import { useActionState } from "react";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { type TestState, testConnectionAction } from "../../actions";

const STEP_LABELS = {
  vault: "SSH key from the vault",
  ssh: "SSH connection",
  "wp-cli": "WP-CLI",
  wordpress: "WordPress",
} as const;

export function TestConnection({ siteId, kind }: { siteId: string; kind: EnvKind }) {
  const [state, action] = useActionState<TestState, FormData>(testConnectionAction, {});
  const result = state.result;
  return (
    <form action={action} className="grid gap-3">
      <FormPendingOverlay label="Testing connection…" />
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="kind" value={kind} />
      <div>
        <PendingSubmit variant="outline" pendingLabel="Testing…">
          Test connection
        </PendingSubmit>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {result && (
        <div role="status" className="grid gap-2 rounded-md border p-3 text-sm">
          <ul className="grid gap-1.5">
            {result.steps.map((step) => (
              <li key={step.name} className="flex items-start gap-2">
                {step.ok ? (
                  <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <span>
                  <span className="font-medium">{STEP_LABELS[step.name]}</span>
                  <span className="sr-only">{step.ok ? ": passed" : ": failed"}</span>
                  <span className="block text-xs break-words text-muted-foreground">
                    {step.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {result.hostKeyMismatch && (
            <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-destructive">
              The server&apos;s host key doesn&apos;t match the pinned one, so UlixOps refused to
              connect. This can mean the server was rebuilt, or that someone is intercepting the
              connection. Admins were alerted. Check with the host before resetting the key.
            </p>
          )}
          {result.hostKeyPinned && (
            <p className="text-muted-foreground">
              First successful connection: the server&apos;s host key is now pinned.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {result.ok ? "All checks passed" : "Stopped at the first failed check"} in{" "}
            {(result.durationMs / 1000).toFixed(1)} s.
          </p>
        </div>
      )}
    </form>
  );
}
