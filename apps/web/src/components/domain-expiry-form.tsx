"use client";
// Admin-entered expiry date for a domain whose registry publishes none (A148).
import type { DomainView } from "@ulixops/shared";
import { setDomainExpiryAction } from "@/app/(app)/monitoring/actions";
import { ActionForm } from "@/components/action-form";
import { Input } from "@/components/ui/input";

export function DomainExpiryForm({ domain, siteId }: { domain: DomainView; siteId?: string }) {
  const id = `expiry-${domain.domain}`;
  return (
    <ActionForm
      action={setDomainExpiryAction}
      submitLabel={domain.manual ? "Update date" : "Set date"}
      variant="outline"
      pendingLabel="Saving…"
      className="min-w-44"
    >
      <input type="hidden" name="domain" value={domain.domain} />
      {siteId && <input type="hidden" name="siteId" value={siteId} />}
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Expiry date from the registrar (empty clears it)
      </label>
      <Input
        id={id}
        name="expiresAt"
        type="date"
        defaultValue={domain.manual && domain.expiresAt ? domain.expiresAt.slice(0, 10) : ""}
      />
    </ActionForm>
  );
}
