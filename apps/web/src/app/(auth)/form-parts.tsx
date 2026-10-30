"use client";
import type { ComponentProps } from "react";
import { FormPendingOverlay, PendingSubmit } from "@/components/pending-ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string; name: string } & ComponentProps<"input">) {
  const id = input.id ?? input.name;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function SubmitButton({ children, pendingText }: { children: string; pendingText: string }) {
  return (
    <>
      <FormPendingOverlay label={pendingText} />
      <PendingSubmit pendingLabel={pendingText} className="w-full">
        {children}
      </PendingSubmit>
    </>
  );
}

export function CodeField() {
  return (
    <Field
      label="6-digit code"
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]{6,7}"
      maxLength={7}
      required
      autoFocus
    />
  );
}
