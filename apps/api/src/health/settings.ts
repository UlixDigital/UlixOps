import {
  DEFAULT_HEALTH_THRESHOLD_MS,
  HealthCheckSettings,
  type HealthCheckSettings as HealthSettings,
} from "@ulixops/shared";
import type { Db } from "../db";

export const HEALTH_SETTINGS_KEY = "health.check";

const DEFAULT: HealthSettings = {
  extraPaths: [],
  thresholdMs: DEFAULT_HEALTH_THRESHOLD_MS,
  checkErrorLog: true,
  checkWpAdmin: false,
};

export async function readHealthSettings(db: Db): Promise<HealthSettings> {
  const row = await db.setting.findUnique({ where: { key: HEALTH_SETTINGS_KEY } });
  const parsed = HealthCheckSettings.safeParse(row?.value ?? {});
  return parsed.success ? HealthCheckSettings.parse(parsed.data) : DEFAULT;
}

export async function writeHealthSettings(
  db: Db,
  value: HealthSettings,
  userId: string,
): Promise<HealthSettings> {
  const next = HealthCheckSettings.parse(value);
  await db.setting.upsert({
    where: { key: HEALTH_SETTINGS_KEY },
    create: { key: HEALTH_SETTINGS_KEY, value: next, updatedById: userId },
    update: { value: next, updatedById: userId },
  });
  return next;
}
