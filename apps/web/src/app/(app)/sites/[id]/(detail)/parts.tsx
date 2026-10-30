// Pieces shared by the site detail tabs.
import type { EnvironmentView, SiteView } from "@ulixops/shared";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { EnvBadge } from "@/components/env-badge";
import { ENV_LABELS } from "@/lib/site-status";
import { cn } from "@/lib/utils";
import { refreshInventoryAction } from "../../actions";

export { EnvBadge };

/** Production / Staging switch for a tab. Always shows which environment is active. */
export function EnvSwitcher({
  site,
  current,
  path,
}: {
  site: SiteView;
  current: EnvironmentView;
  path: string;
}) {
  if (site.environments.length < 2) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Environment</span>
        <EnvBadge kind={current.kind} />
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Environment</span>
      <div role="group" aria-label="Environment" className="inline-flex rounded-md border p-0.5">
        {site.environments.map((env) => {
          const active = env.kind === current.kind;
          return (
            <Link
              key={env.kind}
              href={`/sites/${site.id}${path}${env.kind === "STAGING" ? "?env=staging" : ""}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded px-2.5 py-1 text-sm transition-colors duration-150",
                active
                  ? env.kind === "STAGING"
                    ? "bg-warning/15 font-medium text-warning"
                    : "bg-accent font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {ENV_LABELS[env.kind]}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Why UlixOps won't run commands on this environment yet, if anything stops it. */
export function remoteBlocker(site: SiteView, env: EnvironmentView): string | null {
  if (site.archived) return "This site is archived. Restore it to run commands on it.";
  if (!env.hostKey)
    return "Run Test connection on the Overview first: commands run only once the server's host key is pinned.";
  return null;
}

/** Fast inventory: installed versions only (A114). Prefer this for day-to-day refresh. */
export function RefreshInventory({ siteId, env }: { siteId: string; env: EnvironmentView }) {
  return (
    <ActionForm
      action={refreshInventoryAction}
      submitLabel={env.inventory ? "Refresh inventory" : "Read inventory"}
      pendingLabel="Reading inventory…"
      variant="outline"
      // Fast path skips update servers (~10–30s on WP Engine).
      expectedMs={20_000}
    >
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="kind" value={env.kind} />
      <input type="hidden" name="checkUpdates" value="false" />
    </ActionForm>
  );
}

/** Contacts WP.org / vendor update APIs; slower; use when you need Update buttons (A114). */
export function CheckInventoryUpdates({ siteId, env }: { siteId: string; env: EnvironmentView }) {
  return (
    <ActionForm
      action={refreshInventoryAction}
      submitLabel="Check for updates"
      pendingLabel="Checking for updates…"
      variant="outline"
      expectedMs={60_000}
    >
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="kind" value={env.kind} />
      <input type="hidden" name="checkUpdates" value="true" />
    </ActionForm>
  );
}

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "success" | "warning" | "error";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "success" && "bg-success/10 text-success",
        tone === "warning" && "bg-warning/10 text-warning",
        tone === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </span>
  );
}
