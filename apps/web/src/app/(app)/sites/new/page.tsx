import { can } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiAuth, requireSession } from "@/lib/auth";
import { vaultKeyNames } from "@/lib/credentials";
import { createSiteAction } from "../actions";
import { SiteForm } from "../site-form";

export const metadata: Metadata = { title: "Add site · UlixOps" };

export default async function NewSitePage() {
  const { user } = await requireSession();
  if (!can(user.role, "sites.manage")) return <NoAccess role={user.role} what="adding sites" />;
  const credentials = await vaultKeyNames(await apiAuth());

  return (
    <div className="grid max-w-3xl gap-4">
      <Link href="/sites" className="text-sm text-muted-foreground hover:text-foreground">
        ← Sites
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add site</CardTitle>
          <CardDescription>
            Nothing connects to the site until you press Test connection on the next page. For WP
            Engine, use the SSH Gateway: host <code>install.ssh.wpengine.net</code>, user and path
            from the install name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SiteForm action={createSiteAction} credentials={credentials} submitLabel="Add site" />
        </CardContent>
      </Card>
    </div>
  );
}
