"use server";

import {
  DEFAULT_HEALTH_THRESHOLD_MS,
  HealthCheckSettings,
  HealthPath,
  MAX_HEALTH_EXTRA_PATHS,
  MAX_HEALTH_THRESHOLD_MS,
  MIN_HEALTH_THRESHOLD_MS,
} from "@ulixops/shared";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/components/action-form";
import { apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { setFlash } from "@/lib/flash";
import { errorMessage } from "@/lib/messages";

function parsePaths(raw: FormDataEntryValue | null): string[] | { error: string } {
  if (typeof raw !== "string") return [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > MAX_HEALTH_EXTRA_PATHS) {
    return { error: `At most ${MAX_HEALTH_EXTRA_PATHS} extra paths.` };
  }
  const paths: string[] = [];
  for (const line of lines) {
    const parsed = HealthPath.safeParse(line);
    if (!parsed.success) {
      return { error: `Invalid path: ${line}. Paths must start with / and stay under the site.` };
    }
    paths.push(parsed.data);
  }
  return paths;
}

export async function saveHealthCheckAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const paths = parsePaths(form.get("extraPaths"));
  if ("error" in paths) return { error: paths.error };

  const thresholdRaw = form.get("thresholdMs");
  const thresholdMs =
    typeof thresholdRaw === "string" && thresholdRaw.trim() !== ""
      ? Number(thresholdRaw)
      : DEFAULT_HEALTH_THRESHOLD_MS;
  if (
    !Number.isInteger(thresholdMs) ||
    thresholdMs < MIN_HEALTH_THRESHOLD_MS ||
    thresholdMs > MAX_HEALTH_THRESHOLD_MS
  ) {
    return {
      error: `Response-time threshold must be between ${MIN_HEALTH_THRESHOLD_MS} and ${MAX_HEALTH_THRESHOLD_MS} ms.`,
    };
  }

  const checkErrorLog = form.get("checkErrorLog") === "on";
  const parsed = HealthCheckSettings.safeParse({
    extraPaths: paths,
    thresholdMs,
    checkErrorLog,
  });
  if (!parsed.success) return { error: "Check the paths and threshold, then try again." };

  const res = await apiSend(
    "PUT",
    "/settings/health-check",
    parsed.data,
    HealthCheckSettings,
    await apiAuth(),
  );
  if (!res.ok) return { error: errorMessage(res.error) };
  await setFlash("Health-check settings saved.");
  revalidatePath("/settings");
  return {};
}
