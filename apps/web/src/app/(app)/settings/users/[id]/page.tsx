import { UserDetail } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RoleOptions, Select } from "@/components/ui/select";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { describeDevice, formatUtc, ROLE_LABELS, timeAgo } from "@/lib/format";
import { statusOf } from "@/lib/user-status";
import { cn } from "@/lib/utils";
import {
  changeRoleAction,
  newSetupLinkAction,
  resetTwoFactorAction,
  revokeUserSessionAction,
  setActiveAction,
} from "../../actions";

export const metadata: Metadata = { title: "Manage person · UlixOps" };

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, res] = await Promise.all([
    requireSession(),
    /^[a-z0-9]{1,64}$/.test(id) ? apiGet(`/users/${id}`, UserDetail, await apiAuth()) : null,
  ]);
  if (!res?.ok) notFound();
  const { user, sessions } = res.data;
  const self = user.id === me.user.id;
  const status = statusOf(user);
  const hidden = <input type="hidden" name="userId" value={user.id} />;

  return (
    <div className="grid gap-4">
      <Link href="/settings/users" className="text-sm text-muted-foreground hover:text-foreground">
        ← Users &amp; roles
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{user.name ?? user.email}</h2>
        <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", status.tone)}>
          {status.label}
        </span>
        {self && <span className="text-xs text-muted-foreground">(you)</span>}
      </div>
      <p className="-mt-2 text-sm text-muted-foreground">
        {user.email} · {ROLE_LABELS[user.role]} · last sign-in {timeAgo(user.lastLoginAt)}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Role</CardTitle>
            <CardDescription>
              {self
                ? "You can't change your own role. Ask another Admin."
                : "Takes effect on their next click."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!self && (
              <ActionForm action={changeRoleAction} submitLabel="Save role">
                {hidden}
                <Label htmlFor="role" className="sr-only">
                  Role
                </Label>
                <Select id="role" name="role" defaultValue={user.role}>
                  <RoleOptions />
                </Select>
              </ActionForm>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Access</CardTitle>
            <CardDescription>Every change here is recorded in the audit log.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {!self && (
              <ActionForm
                action={newSetupLinkAction}
                submitLabel={
                  user.setupPending ? "Create a new setup link" : "Create a password reset link"
                }
                variant="outline"
                linkNote={
                  user.setupPending
                    ? "New setup link: older links no longer work. Send it to them privately."
                    : "Password reset link: send it privately. When they use it, all their sessions end; they still need their 2FA code."
                }
              >
                {hidden}
                <p className="text-sm text-muted-foreground">
                  {user.setupPending
                    ? "They haven't used their setup link yet."
                    : "Forgotten password? They choose a new one with this link."}
                </p>
              </ActionForm>
            )}
            {!self && !user.setupPending && user.twoFactorEnabled && (
              <ActionForm
                action={resetTwoFactorAction}
                submitLabel="Reset 2FA"
                variant="destructive"
                confirm={{
                  title: `Reset 2FA for ${user.email}?`,
                  description:
                    "Their authenticator stops working and they are signed out everywhere. At their next sign-in they set up 2FA again. Admins are alerted.",
                }}
              >
                {hidden}
                <p className="text-sm text-muted-foreground">For a lost or replaced phone.</p>
              </ActionForm>
            )}
            {!self && (
              <ActionForm
                action={setActiveAction}
                submitLabel={user.active ? "Remove access" : "Restore access"}
                variant={user.active ? "destructive" : "outline"}
                confirm={
                  user.active
                    ? {
                        title: `Remove access for ${user.email}?`,
                        description:
                          "They are signed out at once and can't sign in until an Admin restores access.",
                      }
                    : undefined
                }
              >
                {hidden}
                <input type="hidden" name="active" value={user.active ? "false" : "true"} />
              </ActionForm>
            )}
            {self && (
              <p className="text-sm text-muted-foreground">
                Manage your own sign-in under My account.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active sessions</CardTitle>
          <CardDescription>Signed-in browsers right now.</CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not signed in anywhere.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <span>
                    {describeDevice(session.userAgent)}
                    {session.current && (
                      <span className="ml-2 text-xs text-muted-foreground">(this browser)</span>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {session.ip ?? "no IP"} · signed in {formatUtc(session.createdAt)} · active{" "}
                      {timeAgo(session.lastSeenAt)}
                    </span>
                  </span>
                  <ActionForm
                    action={revokeUserSessionAction}
                    submitLabel="End session"
                    variant="destructive"
                    confirm={{
                      title: "End this session?",
                      description: "That browser is signed out at once.",
                    }}
                  >
                    {hidden}
                    <input type="hidden" name="sessionId" value={session.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
