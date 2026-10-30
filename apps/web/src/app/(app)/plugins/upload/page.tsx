// Spec screen 7: upload a plugin version.
import { can } from "@ulixops/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/no-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Upload plugin version · UlixOps" };

export default async function UploadPluginPage() {
  const { user } = await requireSession();
  if (!can(user.role, "plugins.upload")) return <NoAccess role={user.role} what="plugin uploads" />;
  return (
    <div className="grid max-w-3xl gap-4">
      <Link href="/plugins" className="text-sm text-muted-foreground hover:text-foreground">
        ← Plugins
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload plugin version</CardTitle>
          <CardDescription>
            UlixOps checks the ZIP first: its size and type, the archive structure, every path, the
            plugin folder and header, and every file&apos;s contents. Only a ZIP that passes is
            kept, with its SHA-256 checksum, outside the web server&apos;s reach.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UploadForm />
        </CardContent>
      </Card>
    </div>
  );
}
