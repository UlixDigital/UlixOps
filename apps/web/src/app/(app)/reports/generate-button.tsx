"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { generateReportAction } from "./actions";

export function GenerateReportButton({
  siteId,
  periodStart,
  label,
}: {
  siteId: string;
  periodStart: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await generateReportAction(siteId, periodStart);
            if (!res.ok) {
              setError(res.error);
              return;
            }
            router.push(`/reports/${res.report.id}`);
            router.refresh();
          });
        }}
      >
        {pending ? "Building…" : `Generate ${label}`}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
