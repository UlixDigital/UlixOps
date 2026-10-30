"use client";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import { BusyOverlay } from "@/components/pending-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { addPasskeyAction, passkeyOptionsAction } from "@/app/(app)/account/actions";
import { passkeyLoginAction } from "@/app/(auth)/actions";

const CANCELLED = "The passkey prompt was closed, or this device has no passkey for UlixOps.";

/** "Use a passkey" on the sign-in code page. The options come from the API, unchanged. */
export function PasskeyLoginButton({ options }: { options: Record<string, unknown> }) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const signIn = () =>
    startTransition(async () => {
      setError(undefined);
      let credential;
      try {
        // Validated by the API when it was created; the browser API checks the rest.
        credential = await startAuthentication({
          optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
        });
      } catch {
        setError(CANCELLED);
        return;
      }
      const result = await passkeyLoginAction(credential);
      if (result?.error) setError(result.error);
    });
  return (
    <div className="grid gap-2">
      <BusyOverlay pending={pending} label="Waiting for your passkey…" showPercent={false} />
      <Button
        type="button"
        variant="outline"
        onClick={signIn}
        disabled={pending}
        className="w-full"
        aria-busy={pending}
      >
        {pending ? <Spinner className="size-4" /> : <KeyRound aria-hidden className="size-4" />}
        {pending ? "Waiting for your passkey…" : "Use a passkey"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** My account: add a passkey after confirming with the current authenticator code. */
export function AddPasskeyForm() {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const code = String(data.get("code") ?? "");
    startTransition(async () => {
      setError(undefined);
      const step = await passkeyOptionsAction(code);
      if (step.error || !step.options) {
        setError(step.error ?? "Something went wrong. Try again.");
        return;
      }
      let credential;
      try {
        credential = await startRegistration({
          optionsJSON: step.options as unknown as PublicKeyCredentialCreationOptionsJSON,
        });
      } catch {
        setError("The passkey prompt was closed, or this passkey is already registered.");
        return;
      }
      const saved = await addPasskeyAction(name, credential);
      if (saved.error) setError(saved.error);
      else form.reset();
    });
  };
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
      <BusyOverlay pending={pending} label="Follow your browser…" showPercent={false} />
      <div className="grid gap-1.5">
        <Label htmlFor="passkey-name">Name</Label>
        <Input
          id="passkey-name"
          name="name"
          placeholder="e.g. Work laptop"
          maxLength={60}
          required
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="passkey-code">Current 6-digit code</Label>
        <Input
          id="passkey-code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
        />
      </div>
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? (
          <>
            <Spinner className="size-4" />
            Follow your browser…
          </>
        ) : (
          "Add passkey"
        )}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:col-span-3">
          {error}
        </p>
      )}
    </form>
  );
}
