import "server-only";
// One-site quick action used by /api/sites/quick-action (A119). Kept off Server Actions so a
// mid-run deploy cannot invalidate hashed action IDs mid-batch.
import {
  can,
  EnvKind,
  HealthCheckResponse,
  InventoryRefreshResponse,
  RecordId,
  type RoleName,
  TestConnectionResponse,
} from "@ulixops/shared";
import { z } from "zod";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { errorMessage } from "@/lib/messages";

export const QuickActionKind = z.enum(["test", "inventory", "updates", "health"]);
export type QuickActionKind = z.infer<typeof QuickActionKind>;

export const QuickSiteActionRequest = z.object({
  siteId: RecordId,
  kind: EnvKind,
  action: QuickActionKind,
  siteName: z.string().min(1).max(200),
});
export type QuickSiteActionRequest = z.infer<typeof QuickSiteActionRequest>;

export type QuickSiteActionResult = {
  siteId: string;
  name: string;
  ok: boolean;
  /** Unhealthy health check answered; not an infrastructure failure. */
  unhealthy?: boolean;
  detail: string;
};

export function quickActionAllowed(role: RoleName, action: QuickActionKind): boolean {
  if (action === "test") return can(role, "sites.manage");
  return can(role, "sites.refresh");
}

/** Runs one existing API op for one site environment. Never throws. */
export async function executeQuickSiteAction(
  input: QuickSiteActionRequest,
): Promise<QuickSiteActionResult> {
  const base = { siteId: input.siteId, name: input.siteName };
  const auth = await apiAuth();
  const env = input.kind.toLowerCase();
  try {
    if (input.action === "test") {
      const res = await apiSend(
        "POST",
        `/sites/${input.siteId}/environments/${env}/test`,
        {},
        TestConnectionResponse,
        auth,
        { timeoutMs: 70_000 },
      );
      if (!res.ok) return { ...base, ok: false, detail: errorMessage(res.error) };
      return {
        ...base,
        ok: res.data.ok,
        detail: res.data.ok
          ? `Connected in ${(res.data.durationMs / 1000).toFixed(1)} s`
          : "Connection checks failed",
      };
    }
    if (input.action === "inventory" || input.action === "updates") {
      const res = await apiSend(
        "POST",
        `/sites/${input.siteId}/environments/${env}/inventory`,
        { checkUpdates: input.action === "updates" },
        InventoryRefreshResponse,
        auth,
        { timeoutMs: 200_000 },
      );
      if (!res.ok) return { ...base, ok: false, detail: errorMessage(res.error) };
      if (res.data.hostKeyMismatch) {
        return {
          ...base,
          ok: false,
          detail: "Host key mismatch — nothing ran. Check with the host before resetting the key.",
        };
      }
      if (res.data.job.status !== "SUCCEEDED") {
        const reason = res.data.job.output.split("\n").find((line) => line.trim()) ?? "no output";
        return {
          ...base,
          ok: false,
          detail: `Failed: ${res.data.job.summary}. ${reason.slice(0, 300)}`,
        };
      }
      return { ...base, ok: true, detail: "Done" };
    }
    const res = await apiSend(
      "POST",
      `/sites/${input.siteId}/environments/${env}/health`,
      {},
      HealthCheckResponse,
      auth,
      { timeoutMs: 100_000 },
    );
    if (!res.ok) return { ...base, ok: false, detail: errorMessage(res.error) };
    if (res.data.hostKeyMismatch) {
      return {
        ...base,
        ok: false,
        detail: "Host key mismatch — nothing ran. Check with the host before resetting the key.",
      };
    }
    if (res.data.health?.ok) {
      return { ...base, ok: true, detail: res.data.health.summary };
    }
    if (res.data.health) {
      return {
        ...base,
        ok: false,
        unhealthy: true,
        detail: res.data.health.summary,
      };
    }
    const reason = res.data.job.output.split("\n").find((line) => line.trim()) ?? "no output";
    return {
      ...base,
      ok: false,
      detail: `Failed: ${res.data.job.summary}. ${reason.slice(0, 300)}`,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 300) : "Unexpected error",
    };
  }
}
