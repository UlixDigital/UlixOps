"use client";
import { PASSWORD_MIN } from "@ulixops/shared";
import { useActionState } from "react";
import {
  confirmEnrollmentAction,
  type FormState,
  loginAction,
  setPasswordAction,
  verifyCodeAction,
} from "./actions";
import { CodeField, Field, FormError, SubmitButton } from "./form-parts";

const initial: FormState = {};

export function LoginForm() {
  const [state, action] = useActionState(loginAction, initial);
  return (
    <form action={action} className="grid gap-4">
      <Field label="Email" name="email" type="email" autoComplete="username" required autoFocus />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <FormError message={state.error} />
      <SubmitButton pendingText="Checking…">Continue</SubmitButton>
    </form>
  );
}

export function VerifyCodeForm() {
  const [state, action] = useActionState(verifyCodeAction, initial);
  return (
    <form action={action} className="grid gap-4">
      <CodeField />
      <FormError message={state.error} />
      <SubmitButton pendingText="Verifying…">Sign in</SubmitButton>
    </form>
  );
}

export function SetPasswordForm({ token, email }: { token: string; email: string }) {
  const [state, action] = useActionState(setPasswordAction, initial);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      {/* Lets password managers save the password against the right account. */}
      <input type="hidden" name="email" value={email} autoComplete="username" />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN}
        hint={`At least ${PASSWORD_MIN} characters. A long passphrase works well.`}
        required
        autoFocus
      />
      <Field
        label="Repeat password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
      />
      <FormError message={state.error} />
      <SubmitButton pendingText="Saving…">Set password</SubmitButton>
    </form>
  );
}

export function EnrollForm() {
  const [state, action] = useActionState(confirmEnrollmentAction, initial);
  return (
    <form action={action} className="grid gap-4">
      <CodeField />
      <FormError message={state.error} />
      <SubmitButton pendingText="Verifying…">Turn on 2FA and sign in</SubmitButton>
    </form>
  );
}
