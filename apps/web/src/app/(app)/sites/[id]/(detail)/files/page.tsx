// Site Files tab (A179): browse and edit the WordPress tree over SSH/SFTP.
import { can, type FilesSftpConnectionView } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiAuth, requireSession } from "@/lib/auth";
import { vaultKeyNames } from "@/lib/credentials";
import { loadSite } from "@/lib/site";
import { ENV_LABELS } from "@/lib/site-status";
import { cn } from "@/lib/utils";
import { FilesBrowser } from "./files-browser";
import { FilesSftpSettings } from "./sftp-settings";

export const metadata: Metadata = { title: "Files · UlixOps" };

export default async function SiteFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const auth = await apiAuth();
  const site = await loadSite((await params).id);
  const kind =
    (await searchParams).env === "staging" && site.environments.some((e) => e.kind === "STAGING")
      ? "STAGING"
      : "PRODUCTION";
  const env = site.environments.find((e) => e.kind === kind) ?? site.environments[0];
  const canRead = can(user.role, "sites.refresh") && !site.archived;
  const canWrite = can(user.role, "sites.manage") && !site.archived;

  const filesSftp: FilesSftpConnectionView = env?.filesSftp ?? {
    enabled: false,
    host: null,
    port: null,
    user: null,
    path: null,
    authKind: "password",
    credentialRef: null,
    passwordSet: false,
    hostKeyPinned: false,
  };
  const canBrowse =
    Boolean(env) &&
    canRead &&
    !site.archived &&
    (filesSftp.enabled || Boolean(env?.hostKey));
  // Do not block the page on the first SFTP list — the browser loads it (A183). Session pool
  // on the runner then keeps later folder clicks fast.
  const keys = canWrite ? ((await vaultKeyNames(auth)) ?? []) : [];
  if (env && !keys.includes(env.credentialRef)) keys.unshift(env.credentialRef);

  return (
    <div className="grid min-w-0 gap-4">
      <Card className="min-w-0">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 flex-1 basis-72 gap-1.5">
            <CardTitle className="text-base">Files</CardTitle>
            <CardDescription>
              Browse the WordPress folder over SSH (SFTP). Admins can create, edit, upload, rename
              and delete. Every change is audited; file contents are never stored in the audit log.
              Prefer staging when trying edits.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {site.environments.length > 1 &&
              site.environments.map((e) => (
                <Link
                  key={e.kind}
                  href={`/sites/${site.id}/files${e.kind === "STAGING" ? "?env=staging" : ""}`}
                  aria-current={e.kind === kind ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150",
                    e.kind === kind
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {ENV_LABELS[e.kind]}
                </Link>
              ))}
          </div>
        </CardHeader>
        <CardContent>
          {!env ? (
            <Notice tone="error">This site has no environments.</Notice>
          ) : site.archived ? (
            <Notice>Archived sites can&apos;t be edited.</Notice>
          ) : !canRead ? (
            <Notice>You don&apos;t have permission to open files over SSH.</Notice>
          ) : (
            <div className="grid gap-4">
              <FilesSftpSettings
                siteId={site.id}
                kind={kind}
                canWrite={canWrite}
                initial={filesSftp}
                credentialNames={keys.length ? keys : [env.credentialRef]}
                defaults={{
                  host: env.sshHost,
                  user: env.sshUser,
                  path: env.wpPath,
                  credentialRef: env.credentialRef,
                }}
              />
              {!canBrowse ? (
                <Notice>
                  Connection isn&apos;t tested yet. Run{" "}
                  <Link href={`/sites/${site.id}`} className="text-link hover:underline">
                    Test connection
                  </Link>{" "}
                  on the overview, or turn on a dedicated SFTP connection above (FileZilla host).
                </Notice>
              ) : (
                <FilesBrowser
                  siteId={site.id}
                  kind={kind}
                  wpPath={filesSftp.enabled && filesSftp.path ? filesSftp.path : env.wpPath}
                  canWrite={canWrite}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
