// Integration API keys (A133): request → second Admin approves → requester enters the key once
// within 24 hours. The page only ever shows whether a key is set and when, never the value.
import type { ApiKeyStatus } from "@ulixops/shared";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { formatUtc } from "@/lib/format";
import { cn } from "@/lib/utils";
import { requestApiKeyAction, saveApiKeyAction } from "./api-key-actions";

export function ApiKeyCard({
  status,
  title,
  description,
}: {
  status: ApiKeyStatus | null;
  title: string;
  description: string;
}) {
  const request = status?.request ?? null;
  const canEnter = request?.status === "APPROVED" && request.ownRequest;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {description} Setting or replacing it needs a second Admin&apos;s approval (a Super Admin
          approves their own); the key is then stored only in the vault and is never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!status ? (
          <Notice tone="error">The key status couldn&apos;t be loaded. Refresh the page.</Notice>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs font-medium">{status.name}</span>
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-xs font-medium",
                status.setAt ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
              )}
            >
              {status.setAt
                ? `Set ${formatUtc(status.setAt)}`
                : status.vaultReachable
                  ? "Not set"
                  : "Vault unreachable"}
            </span>
          </div>
        )}

        {status && !request && (
          <ActionForm
            action={requestApiKeyAction}
            submitLabel={status.setAt ? "Request to replace key" : "Request to set key"}
            variant="outline"
          >
            <input type="hidden" name="name" value={status.name} />
          </ActionForm>
        )}

        {request?.status === "PENDING" && (
          <Notice>
            {request.ownRequest ? "Your request" : `${request.requestedBy ?? "An Admin"}'s request`}{" "}
            is waiting for{" "}
            {request.ownRequest ? "another Admin" : "an Admin other than the requester"} to approve
            it on the{" "}
            <Link href="/approvals" className="text-link hover:underline">
              Approvals
            </Link>{" "}
            page.
          </Notice>
        )}

        {request?.status === "APPROVED" && !request.ownRequest && (
          <Notice>
            Approved. {request.requestedBy ?? "The requester"} can enter the key until{" "}
            {request.usableUntil ? formatUtc(request.usableUntil) : "the approval expires"}.
          </Notice>
        )}

        {canEnter && status && (
          <ActionForm action={saveApiKeyAction} submitLabel="Save key in vault">
            <input type="hidden" name="name" value={status.name} />
            <input type="hidden" name="approvalId" value={request.id} />
            <div className="grid max-w-md gap-1.5">
              <Label htmlFor="api-key-value">API key</Label>
              <Input
                id="api-key-value"
                name="value"
                type="password"
                required
                minLength={16}
                maxLength={300}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Approved. Paste the key once, before{" "}
                {request.usableUntil ? formatUtc(request.usableUntil) : "the approval expires"}.
              </p>
            </div>
          </ActionForm>
        )}
      </CardContent>
    </Card>
  );
}
