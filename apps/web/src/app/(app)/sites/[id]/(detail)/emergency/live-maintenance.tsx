"use client";
// Live maintenance badge for Emergency: page paints from inventory, then SSH check (A113).
import { useEffect, useState, useTransition } from "react";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { checkMaintenanceLiveAction, siteActionAction } from "../../../actions";

function StatusBadge({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "warning" && "bg-warning/10 text-warning",
      )}
    >
      {children}
    </span>
  );
}

export function LiveMaintenanceCard({
  siteId,
  kind,
  where,
  blocked,
  initialOn,
}: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  where: string;
  blocked: boolean;
  initialOn: boolean | null;
}) {
  const [on, setOn] = useState<boolean | null>(initialOn);
  const [detail, setDetail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    start(async () => {
      const r = await checkMaintenanceLiveAction(siteId, kind);
      if (cancelled) return;
      if (r.ok) {
        setOn(r.on);
        setDetail(r.detail);
      }
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [siteId, kind]);

  const hidden = (
    <>
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="kind" value={kind} />
    </>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="grid gap-1.5">
          <CardTitle className="text-base">Maintenance mode</CardTitle>
          <CardDescription>
            Visitors see WordPress&apos;s &ldquo;briefly unavailable&rdquo; page while you fix the
            site. Status is checked live over SSH after this page opens (including a leftover{" "}
            <code className="font-mono text-xs">.maintenance</code> file from a stuck update).
          </CardDescription>
        </div>
        {checking && on === null && <StatusBadge>Checking…</StatusBadge>}
        {checking && on !== null && (
          <StatusBadge tone={on ? "warning" : "muted"}>{on ? "On?" : "Off?"}…</StatusBadge>
        )}
        {!checking && on === true && <StatusBadge tone="warning">On</StatusBadge>}
        {!checking && on === false && <StatusBadge>Off</StatusBadge>}
      </CardHeader>
      <CardContent className="grid gap-3">
        {on === true && (
          <Notice tone="error">
            Maintenance is on
            {detail ? `: ${detail}` : ""}. Turn it off to bring the site back for visitors.
          </Notice>
        )}
        {checking && (
          <p className="text-xs text-muted-foreground">Checking live status over SSH…</p>
        )}
        {!blocked && (
          <div className="flex flex-wrap gap-2">
            {on !== true && (
              <ActionForm
                action={siteActionAction}
                submitLabel="Turn on"
                variant="destructive"
                confirm={{
                  title: `Turn maintenance mode on on ${where}?`,
                  description: "Visitors see the maintenance page until you turn it off.",
                }}
              >
                {hidden}
                <input type="hidden" name="action" value="maintenance" />
                <input type="hidden" name="on" value="true" />
              </ActionForm>
            )}
            {/* Always offer Turn off so a stuck .maintenance file can be cleared (A111). */}
            <ActionForm
              action={siteActionAction}
              submitLabel="Turn off"
              variant="outline"
              confirm={{
                title: `Turn maintenance mode off on ${where}?`,
                description:
                  "Removes WordPress maintenance mode and any leftover .maintenance file from a failed update, so the site is served normally again.",
              }}
            >
              {hidden}
              <input type="hidden" name="action" value="maintenance" />
              <input type="hidden" name="on" value="false" />
            </ActionForm>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
