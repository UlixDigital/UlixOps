// Vault credentials (spec 5 and screen 22): SSH key names, age and rotation reminders. Key
// material never reaches this page; a new key's public half is shown once after creating it.
import { ApiKeyStatus, can, CredentialList, ROTATION_DAYS } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { formatUtc } from "@/lib/format";
import { ENV_LABELS } from "@/lib/site-status";
import { cn } from "@/lib/utils";
import { createCredentialAction } from "../actions";
import { ApiKeyCard } from "./api-key-card";

export const metadata: Metadata = { title: "Credentials · UlixOps" };

export default async function CredentialsPage() {
  const { user } = await requireSession();
  if (!can(user.role, "secrets.manage")) return <NoAccess role={user.role} what="credentials" />;
  const auth = await apiAuth();
  // Null when the runner or the vault can't be reached (including a timeout).
  const keyStatus = (name: string) =>
    apiGet(`/credentials/api-keys/${name}`, ApiKeyStatus, auth, { timeoutMs: 15_000 }).then(
      (res) => (res.ok ? res.data : null),
      () => null,
    );
  const [credentials, wordfence, cloudflare] = await Promise.all([
    apiGet("/credentials", CredentialList, auth, { timeoutMs: 15_000 }).then(
      (res) => (res.ok ? res.data.credentials : null),
      () => null,
    ),
    keyStatus("wordfence_api_key"),
    keyStatus("cloudflare_api_token"),
  ]);
  const due = credentials?.filter((c) => c.rotationDue) ?? [];

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create an SSH key</CardTitle>
          <CardDescription>
            The runner makes an Ed25519 key pair and stores the private key in the vault. You get
            the public key to install on the server (WP Engine: User Portal → SSH keys). Nobody,
            including you, ever sees the private key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={createCredentialAction}
            submitLabel="Create key"
            linkLabel="Public key"
            linkNote="Public key: add it to the server's authorized keys, then use this key name when adding the site."
          >
            <div className="grid max-w-sm gap-1.5">
              <Label htmlFor="credential-name">Key name</Label>
              <Input
                id="credential-name"
                name="name"
                placeholder="ACME_SSH_KEY"
                required
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      <ApiKeyCard
        status={wordfence}
        title="Wordfence Intelligence API key"
        description="Lets UlixOps download the Wordfence vulnerability feed for the Security page. Nothing is installed on the sites. Get a free key at wordfence.com → Account → Integrations."
      />

      <ApiKeyCard
        status={cloudflare}
        title="Cloudflare API token"
        description="Lets UlixOps read and change DNS records and purge the cache on the DNS page. Create it in Cloudflare (logged in as the Ulix Digital user that can see the client domains): My Profile → API Tokens → Create Token → Custom token. Permissions: Zone · Zone · Read, Zone · DNS · Edit, Zone · Cache Purge · Purge. Zone Resources: Include · All zones from an account (repeat the row for each client account), or Specific zones. No other permissions. Client domains in another Cloudflare account appear once that account invites the Ulix Digital user as a member."
      />

      <p className="text-sm text-muted-foreground">
        Google Drive backups (client ID, secret, backup key and sign-in) are under{" "}
        <Link href="/settings/google-drive" className="text-link hover:underline">
          Settings → Google Drive
        </Link>
        .
      </p>

      <section className="grid gap-3">
        <h2 className="text-base font-semibold">SSH keys in the vault</h2>
        {!credentials && (
          <Notice tone="error">
            The runner couldn&apos;t list the vault. Check that the runner and the vault are
            running, then refresh.
          </Notice>
        )}
        {due.length > 0 && (
          <Notice>
            {due.length === 1 ? "1 key is" : `${due.length} keys are`} older than {ROTATION_DAYS}{" "}
            days. To rotate: create a new key, install it on the server, switch the site to it
            (another Admin approves), test, then remove the old key from the server and the vault.
          </Notice>
        )}
        {credentials?.length === 0 && (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No SSH keys yet. Create one above.
          </p>
        )}
        {credentials && credentials.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {credentials.map((c) => (
              <li
                key={c.name}
                className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="grid gap-1">
                  <span className="font-mono text-xs font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    Created {formatUtc(c.createdAt)} · {c.ageDays} days old
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {c.usedBy.length === 0
                      ? "Not used by any site"
                      : c.usedBy.map((u, i) => (
                          <span key={`${u.siteId}-${u.kind}`}>
                            {i > 0 && ", "}
                            <Link href={`/sites/${u.siteId}`} className="text-link hover:underline">
                              {u.siteName}
                            </Link>{" "}
                            ({ENV_LABELS[u.kind].toLowerCase()})
                          </span>
                        ))}
                  </span>
                </div>
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-xs font-medium",
                    c.rotationDue ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
                  )}
                >
                  {c.rotationDue ? "Rotation due" : "Current"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
