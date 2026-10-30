// Site health checks (Build Order step 9, spec §6.6).
import { z } from "zod";

/** Relative path under a site origin, e.g. "/" or "/shop/" or "/wp-admin/". */
export const HealthPath = z
  .string()
  .trim()
  .regex(/^\/(?!\/)(?!.*\.\.)[A-Za-z0-9._~/-]{0,200}$/, "a path starting with /");

export const DEFAULT_HEALTH_THRESHOLD_MS = 5_000;
export const MIN_HEALTH_THRESHOLD_MS = 500;
export const MAX_HEALTH_THRESHOLD_MS = 30_000;
export const MAX_HEALTH_EXTRA_PATHS = 20;

/** Always checked in addition to any configured extra paths (agent decision A77). */
export const BUILTIN_HEALTH_PATHS = ["/", "/wp-admin/"] as const;

export const HealthCheckSettings = z.object({
  /** Extra paths beyond homepage and wp-admin (each starts with /). */
  extraPaths: z.array(HealthPath).max(MAX_HEALTH_EXTRA_PATHS).default([]),
  /** Fail a URL when the final response takes longer than this. */
  thresholdMs: z
    .number()
    .int()
    .min(MIN_HEALTH_THRESHOLD_MS)
    .max(MAX_HEALTH_THRESHOLD_MS)
    .default(DEFAULT_HEALTH_THRESHOLD_MS),
  /** Try to read wp-content/debug.log over SFTP when the host key is pinned. */
  checkErrorLog: z.boolean().default(true),
});
export type HealthCheckSettings = z.infer<typeof HealthCheckSettings>;

export const HealthUrlResult = z.object({
  url: z.string().max(500),
  role: z.enum(["home", "wp-admin", "extra"]),
  ok: z.boolean(),
  status: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** Short reason when ok is false (no raw HTML). */
  detail: z.string().max(500),
  /** True when the body matched a critical-error / fatal pattern. */
  criticalText: z.boolean(),
});
export type HealthUrlResult = z.infer<typeof HealthUrlResult>;

export const HealthErrorLogResult = z.object({
  checked: z.boolean(),
  ok: z.boolean(),
  /** Skipped when debug.log is missing or unreadable. */
  skipped: z.boolean(),
  detail: z.string().max(500),
  fatalLines: z.number().int().nonnegative(),
});
export type HealthErrorLogResult = z.infer<typeof HealthErrorLogResult>;

export const HealthJobResult = z.discriminatedUnion("hostKeyMismatch", [
  z.object({
    hostKeyMismatch: z.literal(true),
    expected: z.string(),
    presented: z.string(),
  }),
  z.object({
    hostKeyMismatch: z.literal(false),
    ok: z.boolean(),
    hostKey: z.string(),
    urls: z.array(HealthUrlResult).max(25),
    errorLog: HealthErrorLogResult,
    thresholdMs: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    summary: z.string().max(500),
  }),
]);
export type HealthJobResult = z.infer<typeof HealthJobResult>;

/** Hostnames that only exist on the operator's machine, not inside the runner. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Rewrite a health-check URL so the runner can open a TCP connection (agent decision A80 / A84 / A96).
 * Loopback hosts become `sshHost` on container port 80; host-published :8080 / :8082 map the same way.
 * When `sshHost` is itself loopback (host-side Vitest against published ports), keep :8080/:8082.
 */
export function rewriteHealthFetchUrl(url: string, sshHost: string): string {
  const parsed = new URL(url);
  const loopback = isLoopbackHostname(parsed.hostname);
  const sshIsLoopback = isLoopbackHostname(sshHost);
  const publishedOnSshHost =
    parsed.hostname === sshHost && (parsed.port === "8080" || parsed.port === "8082");
  if (!loopback && !publishedOnSshHost) return url;
  if (loopback) parsed.hostname = sshHost;
  // Inside compose the container listens on 80; on the laptop keep the published port (A96).
  if (!sshIsLoopback) parsed.port = "";
  return parsed.toString();
}

/** Origin the runner should fetch for an environment URL. */
export function healthFetchOrigin(siteUrl: string, sshHost: string): string {
  return new URL(rewriteHealthFetchUrl(siteUrl, sshHost)).origin;
}

/**
 * Build absolute check URLs from an environment origin and configured extra paths.
 * Homepage and wp-admin are always included (deduped).
 */
export function buildHealthUrls(origin: string, extraPaths: readonly string[]): string[] {
  const base = new URL(origin);
  const paths = [...BUILTIN_HEALTH_PATHS, ...extraPaths];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const path of paths) {
    const absolute = new URL(path, base).toString();
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    urls.push(absolute);
  }
  return urls;
}

export function healthUrlRole(url: string, origin: string): "home" | "wp-admin" | "extra" {
  const u = new URL(url);
  const base = new URL(origin);
  if (u.origin !== base.origin) return "extra";
  const path = u.pathname.endsWith("/") || u.pathname === "" ? u.pathname || "/" : u.pathname;
  if (path === "/" || path === "") return "home";
  if (path === "/wp-admin" || path.startsWith("/wp-admin/") || path === "/wp-admin/")
    return "wp-admin";
  return "extra";
}

/** Body text that means WordPress (or PHP) is broken (spec §6.6). */
export const CRITICAL_BODY_PATTERNS: readonly RegExp[] = [
  /there has been a critical error on this website/i,
  /fatal error:/i,
  /parse error:/i,
  /uncaught (?:error|exception)/i,
  /allowed memory size of/i,
];

export function bodyLooksCritical(text: string): boolean {
  return CRITICAL_BODY_PATTERNS.some((re) => re.test(text));
}
