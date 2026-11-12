// Central PHP error log viewer (Phase 4 step 1, A159). The runner reads the end of each site's
// wp-content/debug.log over SSH and groups the lines here; the hub keeps the latest reading per
// environment, alerts on new fatal errors and shows them per site and across all sites.
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();
const Env = z.enum(["PRODUCTION", "STAGING"]);

/** How much of the end of debug.log is read. */
export const ERRORLOG_TAIL_BYTES = 512 * 1024;
export const MAX_ERROR_GROUPS = 200;
const MAX_TRACE_LINES = 12;
/** Production sites are read again this often (hourly tick). */
export const ERRORLOG_EVERY_MS = 6 * 60 * 60_000;

// ---- Error logging switch (A160) -----------------------------------------------------------

export const DEBUG_CONSTANTS = ["WP_DEBUG", "WP_DEBUG_LOG", "WP_DEBUG_DISPLAY"] as const;
export type DebugConstant = (typeof DEBUG_CONSTANTS)[number];
/** A constant's value in wp-config.php: true/false, a string (a custom log path), null = not set. */
export const DebugValue = z.union([z.boolean(), z.string().max(300), z.null()]);
export const DebugConstants = z.object({
  WP_DEBUG: DebugValue,
  WP_DEBUG_LOG: DebugValue,
  WP_DEBUG_DISPLAY: DebugValue,
});
export type DebugConstants = z.infer<typeof DebugConstants>;

/** Above this the log is cut to its last ERRORLOG_KEEP_BYTES when UlixOps switched logging on. */
export const ERRORLOG_TRIM_ABOVE = 10 * 1024 * 1024;
export const ERRORLOG_KEEP_BYTES = 2 * 1024 * 1024;

// ---- UlixOps mu-plugin log (A167) — does not depend on wp-config.php --------------------

/** Must-use plugin filename under wp-content/mu-plugins/. */
export const ULIXOPS_ERROR_LOG_PLUGIN = "ulixops-error-log.php";
/** Private directory under wp-content/ (blocked from the web). */
export const ULIXOPS_ERROR_LOG_DIR = "ulixops-logs";
/**
 * Log file is `.php` (not `.log`) so nginx/PHP-FPM hosts (e.g. WP Engine) execute it instead
 * of serving the contents. The file always starts with a PHP exit header (A168).
 */
export const ULIXOPS_ERROR_LOG_FILE = "php-errors.php";
/** Legacy A167 name — deleted on switch-on so it can't stay publicly downloadable. */
export const ULIXOPS_ERROR_LOG_FILE_LEGACY = "php-errors.log";
/** First bytes of every UlixOps private log; HTTP requests exit before any log lines. */
export const ULIXOPS_ERROR_LOG_HEADER = `<?php
// UlixOps private PHP error log. Do not edit.
exit;
?>
`;

export function ulixopsErrorLogPluginPath(wpPath: string): string {
  return `${wpPath.replace(/\/$/, "")}/wp-content/mu-plugins/${ULIXOPS_ERROR_LOG_PLUGIN}`;
}

export function ulixopsErrorLogDirPath(wpPath: string): string {
  return `${wpPath.replace(/\/$/, "")}/wp-content/${ULIXOPS_ERROR_LOG_DIR}`;
}

export function ulixopsErrorLogFilePath(wpPath: string): string {
  return `${ulixopsErrorLogDirPath(wpPath)}/${ULIXOPS_ERROR_LOG_FILE}`;
}

export function ulixopsErrorLogLegacyFilePath(wpPath: string): string {
  return `${ulixopsErrorLogDirPath(wpPath)}/${ULIXOPS_ERROR_LOG_FILE_LEGACY}`;
}

/**
 * Must-use plugin body installed by UlixOps. Logs PHP errors to a private file via ini_set /
 * handlers — no wp-config.php changes (hosts often ignore those).
 */
export const ULIXOPS_ERROR_LOG_PLUGIN_SOURCE = `<?php
/**
 * Plugin Name: UlixOps Error Log
 * Description: Private PHP error logging managed by UlixOps. Do not edit by hand.
 * Version: 1.1.0
 */
if (!defined('ABSPATH')) {
\texit;
}

if (!defined('ULIXOPS_ERROR_LOG')) {
\tdefine('ULIXOPS_ERROR_LOG', WP_CONTENT_DIR . '/${ULIXOPS_ERROR_LOG_DIR}/${ULIXOPS_ERROR_LOG_FILE}');
}

@ini_set('display_errors', '0');
@ini_set('log_errors', '1');
@ini_set('error_log', ULIXOPS_ERROR_LOG);
error_reporting(E_ALL);

/**
 * Ensure the log starts with a PHP exit so a web hit never prints the lines below.
 */
function ulixops_error_log_bootstrap() {
\t$dir = dirname(ULIXOPS_ERROR_LOG);
\tif (!is_dir($dir)) {
\t\t@mkdir($dir, 0750, true);
\t}
\t$header = "<?php\\n// UlixOps private PHP error log. Do not edit.\\nexit;\\n?>\\n";
\tif (!file_exists(ULIXOPS_ERROR_LOG) || filesize(ULIXOPS_ERROR_LOG) === 0) {
\t\t@file_put_contents(ULIXOPS_ERROR_LOG, $header, LOCK_EX);
\t\treturn;
\t}
\t$fh = @fopen(ULIXOPS_ERROR_LOG, 'rb');
\tif (!$fh) {
\t\treturn;
\t}
\t$head = @fread($fh, 96);
\t@fclose($fh);
\tif (is_string($head) && strpos($head, 'exit;') !== false) {
\t\treturn;
\t}
\t$existing = @file_get_contents(ULIXOPS_ERROR_LOG);
\t@file_put_contents(ULIXOPS_ERROR_LOG, $header . (is_string($existing) ? $existing : ''), LOCK_EX);
}

/**
 * Append one line in WordPress debug.log stamp format so UlixOps can parse it.
 */
function ulixops_error_log_line($message) {
\tulixops_error_log_bootstrap();
\t$stamp = '[' . gmdate('d-M-Y H:i:s') . ' UTC] ';
\t@file_put_contents(ULIXOPS_ERROR_LOG, $stamp . $message . "\\n", FILE_APPEND | LOCK_EX);
}

set_error_handler(static function ($errno, $errstr, $errfile, $errline) {
\tif (!(error_reporting() & $errno)) {
\t\treturn false;
\t}
\t$map = array(
\t\tE_ERROR => 'Fatal error',
\t\tE_WARNING => 'Warning',
\t\tE_PARSE => 'Parse error',
\t\tE_NOTICE => 'Notice',
\t\tE_CORE_ERROR => 'Fatal error',
\t\tE_CORE_WARNING => 'Warning',
\t\tE_COMPILE_ERROR => 'Fatal error',
\t\tE_COMPILE_WARNING => 'Warning',
\t\tE_USER_ERROR => 'Fatal error',
\t\tE_USER_WARNING => 'Warning',
\t\tE_USER_NOTICE => 'Notice',
\t\tE_RECOVERABLE_ERROR => 'Fatal error',
\t\tE_DEPRECATED => 'Deprecated',
\t\tE_USER_DEPRECATED => 'Deprecated',
\t);
\t$label = isset($map[$errno]) ? $map[$errno] : 'Error';
\tulixops_error_log_line('PHP ' . $label . ': ' . $errstr . ' in ' . $errfile . ':' . $errline);
\treturn false;
});

register_shutdown_function(static function () {
\t$err = error_get_last();
\tif (!$err) {
\t\treturn;
\t}
\t$fatal = array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR);
\tif (!in_array($err['type'], $fatal, true)) {
\t\treturn;
\t}
\tulixops_error_log_line(
\t\t'PHP Fatal error: ' . $err['message'] . ' in ' . $err['file'] . ':' . $err['line']
\t);
});
`;

export type LoggingState = "on" | "off" | "custom" | "unknown";

/** PHP's truthiness for a wp-config value: `'true'`, `'1'` or any non-empty string count as on. */
const truthy = (v: DebugConstants[DebugConstant]) =>
  v === true || (typeof v === "string" && v !== "" && v !== "0");

/**
 * What WordPress does with these values (wp_debug_mode): logging only when WP_DEBUG is truthy;
 * WP_DEBUG_LOG true, 'true' or '1' → wp-content/debug.log, any other string → that path;
 * errors shown on pages when WP_DEBUG is on and WP_DEBUG_DISPLAY is truthy or not set.
 */
export function loggingState(c: DebugConstants | null): { state: LoggingState; display: boolean } {
  if (!c) return { state: "unknown", display: false };
  const debug = truthy(c.WP_DEBUG);
  const display = debug && (c.WP_DEBUG_DISPLAY === null || truthy(c.WP_DEBUG_DISPLAY));
  if (!debug) return { state: "off", display };
  const log = c.WP_DEBUG_LOG;
  if (log === true || (typeof log === "string" && ["true", "1"].includes(log.toLowerCase())))
    return { state: "on", display };
  if (typeof log === "string" && log !== "" && log !== "0") return { state: "custom", display };
  return { state: "off", display };
}

export const DebugLogJobResult = z.discriminatedUnion("hostKeyMismatch", [
  z.object({ hostKeyMismatch: z.literal(true), presented: z.string() }),
  z.object({
    hostKeyMismatch: z.literal(false),
    hostKey: z.string(),
    ok: z.boolean(),
    /** The log was downloadable from the web, so logging was switched off again. */
    exposed: z.boolean(),
    /** How logging was switched (A167 prefers mu-plugin). */
    method: z.enum(["mu-plugin", "wp-config"]).default("mu-plugin"),
    /** Values before a legacy wp-config change (unused for mu-plugin). */
    previous: DebugConstants.nullable(),
    current: DebugConstants.nullable(),
    /** True when the UlixOps mu-plugin is present on the site. */
    pluginInstalled: z.boolean(),
    detail: z.string().max(1000),
  }),
]);
export type DebugLogJobResult = z.infer<typeof DebugLogJobResult>;

export const LoggingView = z.object({
  state: z.enum(["on", "off", "custom", "unknown"]),
  /** Errors are shown to visitors: a leak to fix in wp-config.php. */
  display: z.boolean(),
  /** UlixOps switched it on (mu-plugin or legacy wp-config). */
  managed: z.boolean(),
  /** A167: logging via UlixOps mu-plugin + private file. */
  viaPlugin: z.boolean().default(false),
  enabledAt: iso.nullable(),
});
export type LoggingView = z.infer<typeof LoggingView>;

export const SetLoggingRequest = z.object({ enabled: z.boolean() });
export const BulkLoggingRequest = z.object({ environmentIds: z.array(id).min(1).max(200) });

export const ErrorLevel = z.enum([
  "fatal",
  "parse",
  "database",
  "warning",
  "notice",
  "deprecated",
  "other",
]);
export type ErrorLevel = z.infer<typeof ErrorLevel>;

export const ERROR_LEVEL_LABELS: Record<ErrorLevel, string> = {
  fatal: "Fatal error",
  parse: "Parse error",
  database: "Database error",
  warning: "Warning",
  notice: "Notice",
  deprecated: "Deprecated",
  other: "Other",
};

/** Levels that break a page (counted as "errors" and alerted for fatal/parse). */
export const SERIOUS_LEVELS: readonly ErrorLevel[] = ["fatal", "parse", "database"];

export const ErrorGroup = z.object({
  level: ErrorLevel,
  message: z.string().max(1000),
  /** "plugin:woocommerce", "theme:astra", "core", "mu-plugin:…" or null. */
  source: z.string().max(120).nullable(),
  file: z.string().max(300).nullable(),
  line: z.number().int().nullable(),
  count: z.number().int().positive(),
  count24h: z.number().int().nonnegative(),
  firstAt: iso.nullable(),
  lastAt: iso.nullable(),
  trace: z.array(z.string().max(300)).max(MAX_TRACE_LINES),
});
export type ErrorGroup = z.infer<typeof ErrorGroup>;

export const ErrorLogResult = z.object({
  /** wp-config.php debug constants (null if they couldn't be read). */
  debug: DebugConstants.nullable(),
  /** UlixOps mu-plugin is installed (A167). */
  pluginInstalled: z.boolean(),
  /** Which file was tailed. */
  logSource: z.enum(["ulixops", "debug.log", "none"]),
  fileFound: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: iso.nullable(),
  /** Read from the middle of a larger file: older lines weren't read. */
  truncated: z.boolean(),
  groups: z.array(ErrorGroup).max(MAX_ERROR_GROUPS),
});
export type ErrorLogResult = z.infer<typeof ErrorLogResult>;

export const ErrorLogJobResult = z.discriminatedUnion("hostKeyMismatch", [
  z.object({ hostKeyMismatch: z.literal(true), presented: z.string() }),
  ErrorLogResult.extend({ hostKeyMismatch: z.literal(false), hostKey: z.string() }),
]);
export type ErrorLogJobResult = z.infer<typeof ErrorLogJobResult>;

// ---- Parsing -------------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};
const STAMP = /^\[(\d{2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: ([^\]]+))?\] (.*)$/;

/** "[17-Sep-2026 09:22:05 UTC]" → Date (other zones are read as UTC: close enough here). */
function stampOf(m: RegExpExecArray): Date | null {
  const month = MONTHS[m[2] ?? ""];
  if (month === undefined) return null;
  const d = new Date(
    Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function levelOf(text: string): { level: ErrorLevel; rest: string } {
  const php = /^PHP ([A-Za-z ]+?):\s+(.*)$/.exec(text);
  if (php) {
    const kind = (php[1] ?? "").toLowerCase();
    const rest = php[2] ?? "";
    if (kind.includes("parse")) return { level: "parse", rest };
    if (kind.includes("fatal")) return { level: "fatal", rest };
    if (kind.includes("warning")) return { level: "warning", rest };
    if (kind.includes("notice")) return { level: "notice", rest };
    if (kind.includes("deprecated")) return { level: "deprecated", rest };
    return { level: "other", rest };
  }
  if (/^WordPress database error/i.test(text)) return { level: "database", rest: text };
  return { level: "other", rest: text };
}

/** Server paths shortened to the WordPress folder, so installs and hosts don't show. */
export function shortPath(path: string): string {
  const m = /\/(wp-content|wp-includes|wp-admin)\/(.*)$/.exec(path);
  if (m) return `${m[1]}/${m[2]}`;
  // WP Engine: …/sites/<install>/ or …/live/<install>/; others: …/html/, public_html/, htdocs/.
  return path
    .replace(/^.*\/(sites|live)\/[^/]+\//, "")
    .replace(/^.*\/(html|public_html|htdocs)\//, "");
}

function sourceOf(file: string | null): string | null {
  if (!file) return null;
  const ext = /^wp-content\/(plugins|themes|mu-plugins)\/([^/]+)/.exec(file);
  if (ext) {
    const kind = ext[1] === "plugins" ? "plugin" : ext[1] === "themes" ? "theme" : "mu-plugin";
    return `${kind}:${(ext[2] ?? "").replace(/\.php$/, "")}`;
  }
  if (/^wp-content\/drop-ins\//.test(file)) return "host";
  if (/^wp-(includes|admin)\//.test(file)) return "core";
  return null;
}

/** " in /path/file.php:12" or " in /path/file.php on line 12". */
const WHERE = /\s+(?:in|thrown in)\s+(\/[^\s:]+\.php)(?::(\d+)| on line (\d+))/;

interface Building {
  at: Date | null;
  level: ErrorLevel;
  message: string;
  file: string | null;
  line: number | null;
  trace: string[];
}

/**
 * Groups debug.log text by level + message: how often, when first and last, where, and the
 * first stack trace. `startsMidFile` drops the first (possibly partial) line.
 */
export function parseErrorLog(
  text: string,
  now: Date,
  opts: { startsMidFile?: boolean; redact?: (s: string) => string } = {},
): ErrorGroup[] {
  const clean = opts.redact ?? ((s: string) => s);
  const lines = text.split(/\r?\n/);
  if (opts.startsMidFile) lines.shift();
  const entries: Building[] = [];
  let current: Building | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    const m = STAMP.exec(line);
    if (m) {
      const { level, rest } = levelOf(m[8] ?? "");
      const where = WHERE.exec(rest);
      const file = where?.[1] ? shortPath(where[1]) : null;
      current = {
        at: stampOf(m),
        level,
        message: rest.replace(WHERE, "").trim().slice(0, 1000),
        file,
        line: where ? Number(where[2] ?? where[3]) : null,
        trace: [],
      };
      entries.push(current);
    } else if (current && current.trace.length < MAX_TRACE_LINES) {
      current.trace.push(
        line
          .trim()
          .replace(/\/[^\s:()]*\/(wp-content|wp-includes|wp-admin)\//g, "$1/")
          .slice(0, 300),
      );
    }
  }
  const day = now.getTime() - 86_400_000;
  const groups = new Map<string, ErrorGroup>();
  for (const e of entries) {
    const message = clean(e.message);
    const key = `${e.level}|${message}|${e.file ?? ""}|${e.line ?? ""}`;
    const at = e.at?.toISOString() ?? null;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        level: e.level,
        message,
        source: sourceOf(e.file),
        file: e.file,
        line: e.line,
        count: 1,
        count24h: e.at && e.at.getTime() >= day ? 1 : 0,
        firstAt: at,
        lastAt: at,
        trace: e.trace.map(clean),
      });
      continue;
    }
    g.count++;
    if (e.at && e.at.getTime() >= day) g.count24h++;
    if (at && (!g.firstAt || at < g.firstAt)) g.firstAt = at;
    if (at && (!g.lastAt || at > g.lastAt)) g.lastAt = at;
  }
  const severity = (l: ErrorLevel) => (SERIOUS_LEVELS.includes(l) ? 0 : l === "warning" ? 1 : 2);
  return [...groups.values()]
    .sort(
      (a, b) =>
        Number(b.count24h > 0) - Number(a.count24h > 0) ||
        severity(a.level) - severity(b.level) ||
        (b.lastAt ?? "").localeCompare(a.lastAt ?? ""),
    )
    .slice(0, MAX_ERROR_GROUPS);
}

/** Occurrences in the last 24 hours by kind, for summaries. */
export function errorCounts(groups: ErrorGroup[]) {
  let fatal = 0;
  let errors = 0;
  let warnings = 0;
  for (const g of groups) {
    if (g.level === "fatal" || g.level === "parse") fatal += g.count24h;
    if (SERIOUS_LEVELS.includes(g.level)) errors += g.count24h;
    if (g.level === "warning") warnings += g.count24h;
  }
  return { fatal, errors, warnings };
}

// ---- Views ---------------------------------------------------------------------------------

export const ErrorLogView = z.object({
  environmentId: id,
  siteId: id,
  siteName: z.string(),
  environment: Env,
  readAt: iso.nullable(),
  ok: z.boolean().nullable(),
  detail: z.string().nullable(),
  fileFound: z.boolean(),
  sizeBytes: z.number().nonnegative(),
  modifiedAt: iso.nullable(),
  truncated: z.boolean(),
  fatal24h: z.number().int(),
  errors24h: z.number().int(),
  warnings24h: z.number().int(),
  logging: LoggingView,
  groups: z.array(ErrorGroup),
});
export type ErrorLogView = z.infer<typeof ErrorLogView>;

export const ErrorLogRow = ErrorLogView.omit({ groups: true }).extend({
  /** The most recent serious error, if any. */
  top: ErrorGroup.nullable(),
});
export type ErrorLogRow = z.infer<typeof ErrorLogRow>;

export const ErrorLogOverview = z.object({
  rows: z.array(ErrorLogRow),
  running: z.boolean(),
  everyHours: z.number().int(),
});
export type ErrorLogOverview = z.infer<typeof ErrorLogOverview>;
