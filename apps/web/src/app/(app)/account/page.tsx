import { AccountInfo, PERMISSIONS, ROLE_PERMISSIONS } from "@ulixops/shared";
import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { describeDevice, formatUtc, ROLE_LABELS, timeAgo } from "@/lib/format";
import { AddPasskeyForm } from "@/components/passkey-buttons";
import {
  removePasskeyAction,
  revokeOtherSessionsAction,
  revokeOwnSessionAction,
  updateProfileAction,
} from "./actions";

export const metadata: Metadata = { title: "My account · UlixOps" };

export default async function AccountPage() {
  const res = await apiGet("/account", AccountInfo, await apiAuth());
  if (!res.ok)
    return <Notice tone="error">Your account couldn't be loaded. Refresh the page.</Notice>;
  const { user, twoFactorEnabled, sessions, passkeys } = res.data;
  const others = sessions.filter((s) => !s.current).length;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">My account</h1>
        <p className="text-sm text-muted-foreground">
          {user.email} · {ROLE_LABELS[user.role]}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile</CardTitle>
            <CardDescription>Your email and role are managed by an Admin.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={updateProfileAction} submitLabel="Save">
              <div className="grid gap-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  defaultValue={user.name ?? ""}
                  maxLength={100}
                  autoComplete="name"
                />
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Two-factor authentication</CardTitle>
            <CardDescription>Required for every UlixOps account.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <p>
              <span className="font-medium">Authenticator app:</span>{" "}
              {twoFactorEnabled ? "on" : "not set up"}
            </p>
            <p>
              <span className="font-medium">Passkeys:</span> {passkeys.length || "none"}
            </p>
            <p className="text-muted-foreground">
              Lost your phone? Ask an Admin to reset your 2FA; you'll set it up again at your next
              sign-in.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Passkeys</CardTitle>
          <CardDescription>
            Sign in with your fingerprint, face or a security key instead of typing a code. You
            still enter your password first. Adding one needs your current authenticator code.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {passkeys.length > 0 && (
            <ul className="divide-y rounded-md border">
              {passkeys.map((passkey) => (
                <li
                  key={passkey.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <span>
                    {passkey.name}
                    {passkey.backedUp && (
                      <span className="ml-2 text-xs text-muted-foreground">(synced)</span>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      added {formatUtc(passkey.createdAt)} · last used {timeAgo(passkey.lastUsedAt)}
                    </span>
                  </span>
                  <ActionForm
                    action={removePasskeyAction}
                    submitLabel="Remove"
                    variant="destructive"
                    confirm={{
                      title: `Remove "${passkey.name}"?`,
                      description: "You can still sign in with your authenticator app code.",
                    }}
                  >
                    <input type="hidden" name="passkeyId" value={passkey.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          <AddPasskeyForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">Where you're signed in</CardTitle>
            <CardDescription>
              Sessions end after 30 minutes without activity, or 12 hours at most.
            </CardDescription>
          </div>
          {others > 0 && (
            <ActionForm
              action={revokeOtherSessionsAction}
              submitLabel="Sign out everywhere else"
              variant="destructive"
              confirm={{
                title: "Sign out everywhere else?",
                description: `Your ${others} other session${others === 1 ? "" : "s"} end at once. This browser stays signed in.`,
              }}
            />
          )}
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-md border">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <span>
                  {describeDevice(session.userAgent)}
                  {session.current && (
                    <span className="ml-2 rounded-md bg-success/10 px-1.5 py-0.5 text-xs font-medium text-success">
                      This browser
                    </span>
                  )}
                  <span className="block text-xs text-muted-foreground">
                    {session.ip ?? "no IP"} · signed in {formatUtc(session.createdAt)} · active{" "}
                    {timeAgo(session.lastSeenAt)}
                  </span>
                </span>
                <ActionForm
                  action={revokeOwnSessionAction}
                  submitLabel={session.current ? "Sign out" : "End session"}
                  variant={session.current ? "outline" : "destructive"}
                  confirm={
                    session.current
                      ? undefined
                      : {
                          title: "End this session?",
                          description: "That browser is signed out at once.",
                        }
                  }
                >
                  <input type="hidden" name="sessionId" value={session.id} />
                  <input type="hidden" name="current" value={String(session.current)} />
                </ActionForm>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What your role can do</CardTitle>
          <CardDescription>
            Anything else is refused, and the refusal is recorded in the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
            {ROLE_PERMISSIONS[user.role].map((permission) => (
              <li key={permission} className="flex gap-2">
                <span aria-hidden className="text-success">
                  ✓
                </span>
                {PERMISSIONS[permission]}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
