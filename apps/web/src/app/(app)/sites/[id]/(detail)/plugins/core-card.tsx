// WordPress core on the Plugins & themes tab (A135): version, offered release, Update button.
import type { EnvKind } from "@ulixops/shared";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { updateCoreAction } from "../../../actions";
import { Badge } from "../parts";

export function CoreCard({
  siteId,
  kind,
  wpVersion,
  coreUpdateVersion,
  wpEngine,
  canUpdate,
}: {
  siteId: string;
  kind: EnvKind;
  wpVersion: string;
  coreUpdateVersion: string | null;
  wpEngine: boolean;
  canUpdate: boolean;
}) {
  // Only show when a core update is offered (hide "Up to date" / not-checked).
  if (!coreUpdateVersion) return null;

  const where = kind === "PRODUCTION" ? "production" : "staging";
  const major =
    coreUpdateVersion.split(".").slice(0, 2).join(".") !==
    wpVersion.split(".").slice(0, 2).join(".");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">WordPress core</CardTitle>
        <CardDescription>
          Updates run the database upgrade, then a health check. If the site is unhealthy
          afterwards, UlixOps re-installs WordPress {wpVersion} automatically.
          {wpEngine &&
            " WP Engine also applies core updates on its own schedule; updating here just does it now."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            Installed: <span className="font-mono">{wpVersion}</span>
          </span>
          <Badge tone="warning">{coreUpdateVersion} available</Badge>
        </div>
        {canUpdate && (
          <ActionForm
            action={updateCoreAction}
            submitLabel={`Update to ${coreUpdateVersion}`}
            pendingLabel="Updating WordPress…"
            expectedMs={180_000}
            confirm={{
              title: `Update WordPress to ${coreUpdateVersion} on ${where}?`,
              description: `${major ? "This is a major release: check that your plugins and theme support it. " : ""}UlixOps updates WordPress ${wpVersion} → ${coreUpdateVersion}, runs the database upgrade and a health check. If the health check fails, it re-installs ${wpVersion} and checks again. Database changes from a major upgrade are not undone.`,
            }}
          >
            <input type="hidden" name="siteId" value={siteId} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="version" value={coreUpdateVersion} />
          </ActionForm>
        )}
      </CardContent>
    </Card>
  );
}
