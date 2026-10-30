import { can, SiteView } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { apiAuth, requireSession } from "@/lib/auth";
import { vaultKeyNames } from "@/lib/credentials";
import { updateSiteAction } from "../../actions";
import { SiteForm } from "../../site-form";

export const metadata: Metadata = { title: "Edit site · UlixOps" };

export default async function EditSitePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireSession();
  if (!can(user.role, "sites.manage")) return <NoAccess role={user.role} what="editing sites" />;
  const { id } = await params;
  if (!/^[a-z0-9]{1,64}$/.test(id)) notFound();
  const auth = await apiAuth();
  const [res, credentials] = await Promise.all([
    apiGet(`/sites/${id}`, SiteView, auth),
    vaultKeyNames(auth),
  ]);
  if (!res.ok) notFound();

  return (
    <div className="grid max-w-3xl gap-4">
      <Link href={`/sites/${id}`} className="text-sm text-muted-foreground hover:text-foreground">
        ← {res.data.name}
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Edit {res.data.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <SiteForm
            action={updateSiteAction}
            site={res.data}
            credentials={credentials}
            submitLabel="Save changes"
          />
        </CardContent>
      </Card>
    </div>
  );
}
