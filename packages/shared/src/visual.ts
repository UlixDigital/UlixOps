// Before/after visual checks (Phase 4 P4-3, A163). Playwright screenshots + pixel diff of
// public pages around deploys and updates. The runner asks a Playwright sidecar; the API never
// opens a browser or reaches the sites.
import { z } from "zod";
import { HealthPath, buildHealthUrls, healthFetchOrigin, type HealthCheckSettings } from "./health";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();
const Env = z.enum(["PRODUCTION", "STAGING"]);

/** Stable file-safe slug for a path ("/" → "home", "/shop/" → "shop"). */
export function visualPageSlug(path: string): string {
  const trimmed = path.trim().replace(/\/+/g, "/");
  if (trimmed === "/" || trimmed === "") return "home";
  return (
    trimmed
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page"
  );
}

export const MAX_VISUAL_PAGES = 10;
export const DEFAULT_VISUAL_VIEWPORT_WIDTH = 1280;
export const DEFAULT_VISUAL_VIEWPORT_HEIGHT = 720;
export const DEFAULT_VISUAL_MAX_DIFF_PERCENT = 1;
export const DEFAULT_VISUAL_PIXEL_THRESHOLD = 0.1;
export const VISUAL_RETENTION_DAYS = 30;
export const VISUAL_KEEP_PER_ENV = 50;

export const VisualCheckSettings = z.object({
  /** Take before/after shots on deploys and plugin/theme/core updates. Off leaves Check now. */
  enabled: z.boolean().default(true),
  /** Fail (CHANGED) when more than this % of pixels differ on any page. */
  maxDiffPercent: z.number().min(0.01).max(50).default(DEFAULT_VISUAL_MAX_DIFF_PERCENT),
  /** pixelmatch threshold 0–1 (higher = more tolerant of anti-aliasing). */
  pixelThreshold: z.number().min(0).max(1).default(DEFAULT_VISUAL_PIXEL_THRESHOLD),
  viewportWidth: z.number().int().min(320).max(1920).default(DEFAULT_VISUAL_VIEWPORT_WIDTH),
  viewportHeight: z.number().int().min(240).max(1080).default(DEFAULT_VISUAL_VIEWPORT_HEIGHT),
});
export type VisualCheckSettings = z.infer<typeof VisualCheckSettings>;

export const VisualCheckTrigger = z.enum([
  "deploy",
  "update",
  "core_update",
  "autoupdate",
  "manual",
]);
export type VisualCheckTrigger = z.infer<typeof VisualCheckTrigger>;

export const VisualCheckStatus = z.enum([
  "PENDING",
  "CAPTURING_BEFORE",
  "WAITING",
  "CAPTURING_AFTER",
  "CLEAN",
  "CHANGED",
  "FAILED",
  "SKIPPED",
]);
export type VisualCheckStatus = z.infer<typeof VisualCheckStatus>;

export const VisualPageRole = z.enum(["home", "extra"]);
export type VisualPageRole = z.infer<typeof VisualPageRole>;

export const VisualPageResult = z.object({
  path: HealthPath,
  slug: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  role: VisualPageRole,
  /** Absolute URL that was opened (after rewrite). */
  url: z.string().max(500),
  ok: z.boolean(),
  status: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  detail: z.string().max(500),
  /** Present on after/once when a before image was available. */
  diffPercent: z.number().min(0).max(100).nullable().optional(),
  changed: z.boolean().optional(),
  beforeFile: z.string().max(200).nullable().optional(),
  afterFile: z.string().max(200).nullable().optional(),
  diffFile: z.string().max(200).nullable().optional(),
});
export type VisualPageResult = z.infer<typeof VisualPageResult>;

export const VisualCaptureMode = z.enum(["before", "after", "once"]);
export type VisualCaptureMode = z.infer<typeof VisualCaptureMode>;

export const VisualPageRequest = z.object({
  path: HealthPath,
  /** Absolute http(s) URL the browser should open (API builds; runner rewrites for test-wp). */
  url: z.url({ protocol: /^https?$/ }).max(500),
  role: VisualPageRole,
});
export type VisualPageRequest = z.infer<typeof VisualPageRequest>;

/** Job result from `site.visual.capture`. */
export const VisualCaptureResult = z.object({
  ok: z.boolean(),
  mode: VisualCaptureMode,
  pages: z.array(VisualPageResult).max(MAX_VISUAL_PAGES),
  /** True when any page exceeded maxDiffPercent (after/once with baseline only). */
  changed: z.boolean(),
  detail: z.string().max(2000),
  durationMs: z.number().int().nonnegative(),
});
export type VisualCaptureResult = z.infer<typeof VisualCaptureResult>;

/** Request file the runner writes for the Playwright sidecar. */
export const VisualSidecarRequest = z.object({
  id: id,
  mode: VisualCaptureMode,
  pages: z.array(VisualPageRequest).min(1).max(MAX_VISUAL_PAGES),
  viewportWidth: z.number().int().min(320).max(1920),
  viewportHeight: z.number().int().min(240).max(1080),
  maxDiffPercent: z.number().min(0.01).max(50),
  pixelThreshold: z.number().min(0).max(1),
  /** Directory on the shared visual-store volume for this check's PNGs. */
  storeDir: z.string().min(1).max(500),
});
export type VisualSidecarRequest = z.infer<typeof VisualSidecarRequest>;

export const VisualSidecarResult = z.object({
  ok: z.boolean(),
  pages: z.array(VisualPageResult).max(MAX_VISUAL_PAGES),
  changed: z.boolean(),
  detail: z.string().max(2000),
  durationMs: z.number().int().nonnegative(),
});
export type VisualSidecarResult = z.infer<typeof VisualSidecarResult>;

export const VisualPageView = z.object({
  id: id,
  path: z.string().max(200),
  slug: z.string().max(80),
  role: VisualPageRole,
  url: z.string().max(500),
  ok: z.boolean(),
  status: z.number().int().nullable(),
  detail: z.string().max(500),
  diffPercent: z.number().nullable(),
  changed: z.boolean(),
  hasBefore: z.boolean(),
  hasAfter: z.boolean(),
  hasDiff: z.boolean(),
});
export type VisualPageView = z.infer<typeof VisualPageView>;

export const VisualCheckView = z.object({
  id: id,
  siteId: id,
  siteName: z.string().max(200),
  environmentId: id,
  environment: Env,
  trigger: VisualCheckTrigger,
  status: VisualCheckStatus,
  summary: z.string().max(500),
  maxDiffPercent: z.number(),
  deploymentId: id.nullable(),
  deploymentTargetId: id.nullable(),
  startedAt: iso,
  finishedAt: iso.nullable(),
  pages: z.array(VisualPageView).max(MAX_VISUAL_PAGES),
});
export type VisualCheckView = z.infer<typeof VisualCheckView>;

export const VisualCheckListItem = VisualCheckView.omit({ pages: true }).extend({
  pageCount: z.number().int().nonnegative(),
  changedPages: z.number().int().nonnegative(),
});
export type VisualCheckListItem = z.infer<typeof VisualCheckListItem>;

export const VisualOverview = z.object({
  recent: z.array(VisualCheckListItem).max(100),
  changedOpen: z.number().int().nonnegative(),
  checkedToday: z.number().int().nonnegative(),
  settings: VisualCheckSettings,
});
export type VisualOverview = z.infer<typeof VisualOverview>;

/**
 * Build the page list for a visual check from the environment URL and health-check paths
 * (homepage + Settings extra paths; never wp-admin — A151 / A163).
 */
function isWpAdminPath(path: string): boolean {
  return path === "/wp-admin" || path === "/wp-admin/" || path.startsWith("/wp-admin/");
}

export function buildVisualPages(
  envUrl: string,
  sshHost: string,
  health: HealthCheckSettings,
): VisualPageRequest[] {
  const origin = healthFetchOrigin(envUrl, sshHost);
  // Never open wp-admin in a browser (A151): drop the setting and any extra path under it.
  const settings: HealthCheckSettings = {
    ...health,
    checkWpAdmin: false,
    extraPaths: health.extraPaths.filter((p) => !isWpAdminPath(p)),
  };
  const urls = buildHealthUrls(origin, settings).slice(0, MAX_VISUAL_PAGES);
  return urls.map((url) => {
    const path = new URL(url).pathname || "/";
    const role: VisualPageRole = path === "/" || path === "" ? "home" : "extra";
    return VisualPageRequest.parse({ path: path.startsWith("/") ? path : `/${path}`, url, role });
  });
}

/** Diff % from changed pixel count and image size. */
export function visualDiffPercent(changedPixels: number, width: number, height: number): number {
  const total = Math.max(1, width * height);
  return Math.min(100, Math.round((10000 * Math.max(0, changedPixels)) / total) / 100);
}
