"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { emailReportAction } from "../actions";

export function EmailReportForm({ reportId }: { reportId: string }) {
  const [extra, setExtra] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Card className="grid gap-3 p-4">
      <div>
        <h2 className="text-sm font-medium">Email PDF</h2>
        <p className="text-xs text-muted-foreground">
          Sends to all active Admins. Optionally add more addresses (comma-separated).
        </p>
      </div>
      <input
        type="text"
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
        placeholder="client@example.com, other@example.com"
        className="max-w-lg rounded-md border bg-background px-2 py-1.5 text-sm"
      />
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            setMessage(null);
            start(async () => {
              const to = extra
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const res = await emailReportAction(reportId, to);
              setMessage(res.ok ? `Sent to ${res.to.join(", ")}` : res.error);
            });
          }}
        >
          {pending ? "Sending…" : "Email report"}
        </Button>
        {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
      </div>
    </Card>
  );
}
