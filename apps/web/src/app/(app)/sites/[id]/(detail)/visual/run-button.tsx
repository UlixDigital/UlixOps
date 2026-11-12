"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { runVisualCheckAction } from "@/app/(app)/monitoring/visual/actions";

export function RunVisualButton({
  siteId,
  kind,
}: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await runVisualCheckAction(siteId, kind);
            if (!res.ok) {
              setError(res.error);
              return;
            }
            router.push(`/monitoring/visual/${res.checkId}`);
            router.refresh();
          });
        }}
      >
        {pending ? "Capturing…" : "Check now"}
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
