"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Polls the server-rendered page while a deployment is still in flight. */
export function LiveRefresh({ intervalMs = 2_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => router.refresh(), intervalMs);
    return () => window.clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
