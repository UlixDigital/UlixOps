// Settings → Google Drive (A145, A146): the OAuth client, the backup key and "Sign in with
// Google". Secrets go in, sealed, through the approval flow; nothing secret is ever shown.
import { ApiKeyStatus, can, FullBackupOverview } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { CopyField } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatBytes } from "@/lib/backups";
import { formatUtc } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ApiKeyCard } from "../credentials/api-key-card";
import { signInWithGoogleAction } from "./actions";

export const metadata: Metadata = { title: "Google Drive · UlixOps" };

export default async function GoogleDrivePage() {
  const { user } = await requireSession();
  if (!can(user.role, "secrets.manage")) return <NoAccess role={user.role} what="Google Drive" />;
  const auth = await apiAuth();
  const keyStatus = (name: string) =>
    apiGet(`/credentials/api-keys/${name}`, ApiKeyStatus, auth, { timeoutMs: 15_000 }).then(
      (res) => (res.ok ? res.data : null),
      () => null,
    );
  const [overview, clientId, clientSecret, backupKey] = await Promise.all([
    apiGet("/full-backups/overview", FullBackupOverview, auth, { timeoutMs: 30_000 }),
    keyStatus("google_drive_client_id"),
    keyStatus("google_drive_client_secret"),
    keyStatus("backup_encryption_key"),
  ]);
  const drive = overview.ok ? overview.data.drive : null;
  const quota =
    drive?.connected && drive.limit
      ? Math.min(100, Math.round(((drive.usage ?? 0) / drive.limit) * 100))
      : null;
  const clientReady = Boolean(drive?.setup.clientId && drive.setup.clientSecret);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Google Drive connection</CardTitle>
          <CardDescription>
            Weekly encrypted backups of every site go to this Google Drive, in the folder “UlixOps
            Backups”. UlixOps can only see the files it creates there.{" "}
            <Link href="/backups/full" className="text-link hover:underline">
              Backups → Full backups
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!drive ? (
            <Notice tone="error">
              The connection status couldn&apos;t be loaded. Refresh the page.
            </Notice>
          ) : drive.connected ? (
            <div className="grid gap-3">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-xs font-medium text-success">
                  Connected
                </span>
                {drive.email ?? "Google Drive"}
                {drive.connectedAt && (
                  <span className="text-muted-foreground">
                    since {formatUtc(drive.connectedAt)}
                  </span>
                )}
              </p>
              {quota !== null && (
                <div className="grid max-w-md gap-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Storage used</span>
                    <span>
                      {formatBytes(drive.usage)} of {formatBytes(drive.limit)}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        quota > 90 ? "bg-destructive" : "bg-primary",
                      )}
                      style={{ width: `${quota}%` }}
                    />
                  </div>
                </div>
              )}
              {!drive.setup.key && (
                <Notice tone="error">
                  No backup encryption key yet: backups can&apos;t run until you add it below.
                </Notice>
              )}
            </div>
          ) : (
            drive.error && <Notice>{drive.error}</Notice>
          )}
          {drive && clientReady && (
            <ActionForm
              action={signInWithGoogleAction}
              submitLabel={drive.connected ? "Sign in with Google again" : "Sign in with Google"}
              variant={drive.connected ? "outline" : "default"}
              pendingLabel="Opening Google…"
            />
          )}
          {drive && !clientReady && (
            <p className="text-sm text-muted-foreground">
              Add the client ID and secret below first; then a Sign in with Google button appears
              here.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">One-time setup in Google Cloud</CardTitle>
          <CardDescription>
            Signed in as the Google account that should hold the backups (ulixdevs@gmail.com).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <ol className="grid list-decimal gap-1.5 pl-5 text-sm">
            <li>
              <a
                href="https://console.cloud.google.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-link hover:underline"
              >
                Google Cloud Console
              </a>
              : select (or create) the project and enable the <b>Google Drive API</b>.
            </li>
            <li>
              <b>Google Auth Platform</b> (OAuth consent screen): audience <b>External</b>, then on
              Audience click <b>Publish app</b>. If it stays in “Testing”, Google signs UlixOps out
              after 7 days.
            </li>
            <li>
              <b>Clients → Create client</b>, type <b>Web application</b>. Under{" "}
              <b>Authorized redirect URIs</b> add exactly this address:
            </li>
          </ol>
          {drive && (
            <CopyField
              value={drive.redirectUri}
              label="Redirect URI"
              note="Authorized redirect URI"
            />
          )}
          <p className="text-sm">
            4. Create, then paste the client ID and secret in the two cards below.
          </p>
        </CardContent>
      </Card>

      <ApiKeyCard
        status={clientId}
        title="Google Drive client ID"
        description="From Google Cloud → Clients → your Web application client. Ends in .apps.googleusercontent.com."
      />
      <ApiKeyCard
        status={clientSecret}
        title="Google Drive client secret"
        description="Shown next to the client ID (starts with GOCSPX-)."
      />
      <ApiKeyCard
        status={backupKey}
        title="Backup encryption key"
        description="Encrypts every backup before it leaves the hub. Create it yourself with: openssl rand -hex 32 (64 characters). Save it in your password manager and break-glass kit FIRST: without it, backups can never be opened, and UlixOps never shows it again. Changing it later only affects new backups."
      />
    </div>
  );
}
