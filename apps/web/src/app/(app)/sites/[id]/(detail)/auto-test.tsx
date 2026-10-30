"use client";
// After smart add-site (A107), run Test connection on the overview without blocking create.
import type { EnvKind } from "@ulixops/shared";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { BusyOverlay } from "@/components/pending-ui";
import { testConnectionAction } from "../../actions";

export function AutoTestOnLoad({ siteId, kinds }: { siteId: string; kinds: EnvKind[] }) {
  const router = useRouter();
  const started = useRef(false);
  const [message, setMessage] = useState("Testing connection…");
  const [done, setDone] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (started.current || kinds.length === 0) return;
    started.current = true;
    startTransition(async () => {
      const notes: string[] = [];
      for (const kind of kinds) {
        const label = kind === "PRODUCTION" ? "Production" : "Staging";
        setMessage(`Testing ${label}…`);
        const form = new FormData();
        form.set("siteId", siteId);
        form.set("kind", kind);
        const state = await testConnectionAction({}, form);
        notes.push(
          state.error
            ? `${label}: ${state.error}`
            : state.result?.ok
              ? `${label}: OK`
              : `${label}: failed`,
        );
      }
      setMessage(notes.join(" · "));
      setDone(true);
      router.replace(`/sites/${siteId}`);
      router.refresh();
    });
  }, [kinds, router, siteId]);

  return (
    <div className="grid gap-2">
      <BusyOverlay pending={!done} label={message} expectedMs={70_000} />
      <p className="text-sm text-muted-foreground" role="status">
        {message}
      </p>
    </div>
  );
}
