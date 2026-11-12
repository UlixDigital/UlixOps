// Spec screen 5: the site header and tabs shared by Overview, Plugins & themes, Emergency and
// Logs. Later-phase tabs (DNS, visual checks) show as "soon".
import { can, isClientViewer } from "@ulixops/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { buttonVariants } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { requireSession } from "@/lib/auth";
import { loadSite } from "@/lib/site";
import { HOST_LABELS } from "@/lib/site-status";
import { setArchivedAction } from "../../actions";
import { SiteActivity } from "./site-activity";
import { SiteTabs } from "./site-tabs";

export default async function SiteLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { user } = await requireSession();
  const site = await loadSite((await params).id);
  const manage = can(user.role, "sites.manage");
  const clientViewer = isClientViewer(user.role);

  return (
    <div className="grid min-w-0 gap-4">
      <Link href="/sites" className="text-sm text-muted-foreground hover:text-foreground">
        ← Sites
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {site.name}
            {site.archived && (
              <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
                (archived)
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            <a
              href={site.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-link hover:underline"
            >
              {site.url.replace(/^https?:\/\//, "")}
            </a>{" "}
            · {HOST_LABELS[site.host]}
            {site.tags.length > 0 && ` · ${site.tags.join(", ")}`}
          </p>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/sites/${site.id}/edit`}
              className={buttonVariants({ variant: "outline" })}
            >
              Edit
            </Link>
            <ActionForm
              action={setArchivedAction}
              submitLabel={site.archived ? "Restore" : "Archive"}
              variant={site.archived ? "outline" : "destructive"}
              confirm={
                site.archived
                  ? undefined
                  : {
                      title: `Request archive for ${site.name}?`,
                      description:
                        "Another Admin must approve. Once archived it disappears from the sites list and future deployments. Nothing on the site itself changes.",
                    }
              }
            >
              <input type="hidden" name="siteId" value={site.id} />
              <input type="hidden" name="archive" value={site.archived ? "false" : "true"} />
            </ActionForm>
          </div>
        )}
      </div>

      {site.pendingApprovals > 0 && (
        <Notice>
          {site.pendingApprovals === 1 ? "A change is" : `${site.pendingApprovals} changes are`}{" "}
          waiting for another Admin.{" "}
          {can(user.role, "approvals.decide") && (
            <Link href="/approvals" className="text-link hover:underline">
              Open Approvals
            </Link>
          )}
        </Notice>
      )}

      {!clientViewer && <SiteActivity siteId={site.id} />}
      <SiteTabs siteId={site.id} clientViewer={clientViewer} />
      {children}
    </div>
  );
}
