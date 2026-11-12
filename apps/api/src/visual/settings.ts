import {
  DEFAULT_VISUAL_MAX_DIFF_PERCENT,
  DEFAULT_VISUAL_PIXEL_THRESHOLD,
  DEFAULT_VISUAL_VIEWPORT_HEIGHT,
  DEFAULT_VISUAL_VIEWPORT_WIDTH,
  VisualCheckSettings,
  type VisualCheckSettings as VisualSettings,
} from "@ulixops/shared";
import type { Db } from "../db";

export const VISUAL_SETTINGS_KEY = "visual.check";

const DEFAULT: VisualSettings = {
  enabled: true,
  maxDiffPercent: DEFAULT_VISUAL_MAX_DIFF_PERCENT,
  pixelThreshold: DEFAULT_VISUAL_PIXEL_THRESHOLD,
  viewportWidth: DEFAULT_VISUAL_VIEWPORT_WIDTH,
  viewportHeight: DEFAULT_VISUAL_VIEWPORT_HEIGHT,
};

export async function readVisualSettings(db: Db): Promise<VisualSettings> {
  const row = await db.setting.findUnique({ where: { key: VISUAL_SETTINGS_KEY } });
  const parsed = VisualCheckSettings.safeParse(row?.value ?? {});
  return parsed.success ? VisualCheckSettings.parse(parsed.data) : DEFAULT;
}

export async function writeVisualSettings(
  db: Db,
  value: VisualSettings,
  userId: string,
): Promise<VisualSettings> {
  const next = VisualCheckSettings.parse(value);
  await db.setting.upsert({
    where: { key: VISUAL_SETTINGS_KEY },
    create: { key: VISUAL_SETTINGS_KEY, value: next, updatedById: userId },
    update: { value: next, updatedById: userId },
  });
  return next;
}
