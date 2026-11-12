// Allowlist of every remote operation UlixOps may run on a site (spec 14.2).
// Anything not listed here cannot be executed. Never add a free-form command or path.
import { z } from "zod";

// Must start with a letter or digit so an argument can never be read as a WP-CLI flag
// (e.g. "--all" or "--uninstall"). Agent decision A6 in docs/DECISIONS.md.
export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
export const version = z.string().regex(/^[0-9a-zA-Z][0-9a-zA-Z.-]{0,29}$/);
/**
 * An installed plugin as WP-CLI names it (its folder or file name), e.g. "js_composer" or
 * "LayerSlider". Wider than `slug` because real plugins use capitals, `_` and `.`; still starts
 * with a letter or digit (never a flag) and has no "..". Agent decision A53.
 */
export const PluginName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
  .refine((name) => !name.includes(".."));
/** Theme folder name as WP-CLI shows it — same rules as PluginName (A104). */
export const ThemeName = PluginName;
export type ThemeName = z.infer<typeof ThemeName>;
/** A WordPress release number, e.g. "6.8" or "6.8.3" (core updates, A135). */
export const CoreVersion = z.string().regex(/^\d{1,2}\.\d{1,2}(\.\d{1,3})?$/);
/** Absolute WordPress path on the server; no "..", no spaces or shell characters. */
export const WpPath = z.string().regex(/^\/(?!.*\.\.)[A-Za-z0-9._/-]{0,250}$/);

/**
 * A site address without the scheme, for search-replace across environments (A157): host,
 * optional port, optional path ("shop.com", "stg.wpenginepowered.com", "example.com/axiom").
 */
export const SiteAddress = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?(\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*$/,
  )
  .max(300);

/**
 * `safe: true` runs WP-CLI without loading plugins or the theme, so it still works when a
 * broken plugin crashes the site (and wp-admin). Agent decision A54.
 */
const safe = z.boolean().optional();

/** Remote temp files UlixOps may create under /tmp (snapshots, DB export/import). */
export const TmpUlixopsFile = z
  .string()
  .regex(/^\/tmp\/ulixops-[a-z0-9][a-z0-9.-]{0,80}\.(sql|zip)$/);

/**
 * When `updates` is false, WP-CLI skips contacting update servers (fast inventory — A114).
 * Omitted or true keeps the previous behaviour (include update / update_version).
 */
const listUpdates = z.boolean().optional();

export const Command = z.discriminatedUnion("op", [
  z.object({ op: z.literal("plugin.list"), safe, updates: listUpdates }),
  z.object({ op: z.literal("theme.list"), safe, updates: listUpdates }),
  z.object({ op: z.literal("plugin.deactivate"), slug: PluginName, safe }),
  z.object({ op: z.literal("plugin.activate"), slug: PluginName }),
  z.object({ op: z.literal("plugin.update"), slug: PluginName }),
  z.object({ op: z.literal("theme.update"), slug: ThemeName }),
  /**
   * Delete an inactive plugin's or theme's files (A137). Never `--force` or `uninstall`: WP-CLI
   * refuses the active theme, and the plugin's uninstall routine (data wipe) never runs.
   */
  z.object({ op: z.literal("plugin.delete"), slug: PluginName }),
  z.object({ op: z.literal("theme.delete"), slug: ThemeName }),
  z.object({ op: z.literal("core.version") }),
  /** Available core releases, from WordPress.org (A135). Skips plugins/themes: read-only. */
  z.object({ op: z.literal("core.check-update") }),
  /**
   * Update core to an exact release (A135). `force` allows a downgrade, used only to roll back
   * to the version that was installed before a failed update.
   */
  z.object({ op: z.literal("core.update"), version: CoreVersion, force: z.boolean().optional() }),
  /**
   * File integrity (A144): WordPress core files against WordPress.org checksums. Runs before
   * WordPress loads, so it works on a broken site.
   */
  z.object({ op: z.literal("core.verify-checksums") }),
  /** File integrity (A144): every plugin from WordPress.org against its checksums (JSON). */
  z.object({ op: z.literal("plugin.verify-checksums") }),
  /**
   * Full backup (A145): a gzip tar of the WordPress folder plus the database dump, on stdout.
   * Caches and other backup plugins' archives are left out. Read-only on the site.
   */
  z.object({ op: z.literal("backup.archive"), wpPath: WpPath, dbFile: TmpUlixopsFile }),
  /**
   * Restore (A152), fed a backup.archive tar.gz on stdin. Database: only the dump (the first
   * member) into /tmp; tar stops reading once it has it.
   */
  z.object({ op: z.literal("restore.database"), dbFile: TmpUlixopsFile }),
  /**
   * Restore (A152): the files over the WordPress folder; never the dump or wp-config.php (the
   * live database login stays). `wpContent` limits it to wp-content. Files added since the
   * backup are kept; existing folders keep their owner and permissions.
   */
  z.object({
    op: z.literal("restore.files"),
    wpPath: WpPath,
    dbFile: TmpUlixopsFile,
    wpContent: z.boolean(),
  }),
  /**
   * Cross-environment restore (A174): drop this site's tables before importing the other
   * environment's dump, so tables that exist only here do not remain. Restore-only.
   */
  z.object({ op: z.literal("db.reset") }),
  /**
   * Cross-environment restore (A174): remove plugins, themes and uploads before the archive
   * is extracted, so copies that exist only on this environment do not remain. Never
   * wp-config.php, mu-plugins, or caches. Restore-only.
   */
  z.object({ op: z.literal("restore.clear-content"), wpPath: WpPath }),
  /** Database upgrade after a core update (A135). */
  z.object({ op: z.literal("core.update-db") }),
  z.object({ op: z.literal("cli.info") }),
  z.object({ op: z.literal("maintenance"), on: z.boolean() }),
  z.object({ op: z.literal("maintenance.status") }),
  z.object({ op: z.literal("cache.flush") }),
  z.object({ op: z.literal("db.export"), file: TmpUlixopsFile }),
  /** wp-config.php debug constants, read and set only by the error-logging switch (A160). */
  z.object({
    op: z.literal("config.get"),
    name: z.enum(["WP_DEBUG", "WP_DEBUG_LOG", "WP_DEBUG_DISPLAY"]),
  }),
  z.object({
    op: z.literal("config.set"),
    name: z.enum(["WP_DEBUG", "WP_DEBUG_LOG", "WP_DEBUG_DISPLAY"]),
    value: z.boolean(),
    /**
     * Add the line just above `$table_prefix` instead of WP-CLI's default "That's all, stop
     * editing!" comment, which some hosts' wp-config.php (WP Engine) don't have (A160).
     */
    anchorTablePrefix: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("config.delete"),
    name: z.enum(["WP_DEBUG", "WP_DEBUG_LOG", "WP_DEBUG_DISPLAY"]),
  }),
  /** The table prefix WordPress uses here (restore across environments, A157). */
  z.object({ op: z.literal("db.prefix") }),
  /** The table prefix inside an extracted dump: its first `…options` table. */
  z.object({ op: z.literal("restore.dump-prefix"), dbFile: TmpUlixopsFile }),
  /**
   * After restoring another environment's database (A157): "//from" → "//to" in every table
   * with the site's prefix, serialized data included, GUIDs left alone. `escaped` does the JSON
   * form ("\/\/from") that page builders store.
   */
  z.object({
    op: z.literal("db.search-replace"),
    from: SiteAddress,
    to: SiteAddress,
    escaped: z.boolean(),
  }),
  z.object({ op: z.literal("db.import"), file: TmpUlixopsFile }),
]);
export type Command = z.infer<typeof Command>;

// Returns an argv array (never a shell string). The runner passes args safely.
// With `wpPath`, WP-CLI is pointed at that install (`--path=`), validated like every argument.
export function toArgv(input: unknown, opts: { wpPath?: string } = {}): string[] {
  const argv = commandArgv(Command.parse(input));
  // --path= is for WP-CLI only; other programs (tar) carry their paths in the command itself.
  if (opts.wpPath === undefined || argv[0] !== "wp") return argv;
  return ["wp", `--path=${WpPath.parse(opts.wpPath)}`, ...argv.slice(1)];
}

const SKIP_CODE = ["--skip-plugins", "--skip-themes"];
/** Regenerated caches and other backup plugins' own archives: never worth backing up again. */
const BACKUP_EXCLUDES = [
  "./wp-content/cache",
  "./wp-content/upgrade",
  "./wp-content/updraft",
  "./wp-content/ai1wm-backups",
  "./wp-content/backups-dup-pro",
  "./wp-content/backup-db",
  "./wp-content/uploads/backwpup*",
];
/** Fields read from `wp plugin list` / `wp theme list` (see SiteInventory in sites.ts). */
const LIST_FIELDS = "--fields=name,title,status,version,update,update_version";
/** Fast inventory: no update probes (A114). */
const LIST_FIELDS_FAST = "--fields=name,title,status,version";

function listFields(updates: boolean | undefined): string {
  return updates === false ? LIST_FIELDS_FAST : LIST_FIELDS;
}

function commandArgv(c: Command): string[] {
  switch (c.op) {
    case "plugin.list":
      return [
        "wp",
        "plugin",
        "list",
        "--format=json",
        listFields(c.updates),
        ...(c.safe ? SKIP_CODE : []),
      ];
    case "theme.list":
      return [
        "wp",
        "theme",
        "list",
        "--format=json",
        listFields(c.updates),
        ...(c.safe ? SKIP_CODE : []),
      ];
    case "plugin.deactivate":
      return ["wp", "plugin", "deactivate", c.slug, ...(c.safe ? SKIP_CODE : [])];
    case "plugin.activate":
      return ["wp", "plugin", "activate", c.slug];
    case "plugin.update":
      return ["wp", "plugin", "update", c.slug];
    case "theme.update":
      return ["wp", "theme", "update", c.slug];
    case "plugin.delete":
      return ["wp", "plugin", "delete", c.slug];
    case "theme.delete":
      return ["wp", "theme", "delete", c.slug];
    case "core.version":
      return ["wp", "core", "version"];
    case "core.check-update":
      return [
        "wp",
        "core",
        "check-update",
        "--format=json",
        "--fields=version,update_type",
        ...SKIP_CODE,
      ];
    case "core.update":
      return ["wp", "core", "update", `--version=${c.version}`, ...(c.force ? ["--force"] : [])];
    case "core.update-db":
      return ["wp", "core", "update-db"];
    case "backup.archive":
      return [
        "tar",
        "-czf",
        "-",
        ...BACKUP_EXCLUDES.map((d) => `--exclude=${d}`),
        "-C",
        "/tmp",
        c.dbFile.slice("/tmp/".length),
        "-C",
        c.wpPath,
        ".",
      ];
    case "config.get":
      return ["wp", "config", "get", c.name, "--type=constant", "--format=json", ...SKIP_CODE];
    case "config.set":
      return [
        "wp",
        "config",
        "set",
        c.name,
        c.value ? "true" : "false",
        "--raw",
        "--type=constant",
        ...(c.anchorTablePrefix ? ["--anchor=$table_prefix", "--placement=before"] : []),
        ...SKIP_CODE,
      ];
    case "config.delete":
      return ["wp", "config", "delete", c.name, "--type=constant", ...SKIP_CODE];
    case "db.prefix":
      return ["wp", "db", "prefix", ...SKIP_CODE];
    case "restore.dump-prefix":
      // Match common mysqldump forms (with/without IF NOT EXISTS, optional quotes) — A173.
      return [
        "grep",
        "-m",
        "1",
        "-oE",
        "CREATE TABLE( IF NOT EXISTS)? [`']?[A-Za-z0-9_]+options[`']?",
        c.dbFile,
      ];
    case "db.search-replace": {
      const mark = c.escaped ? "\\/\\/" : "//";
      return [
        "wp",
        "search-replace",
        `${mark}${c.from}`,
        `${mark}${c.to}`,
        "--all-tables-with-prefix",
        "--skip-columns=guid",
        "--report-changed-only",
        ...SKIP_CODE,
      ];
    }
    case "restore.database":
      return [
        "tar",
        "-xzf",
        "-",
        "--occurrence=1",
        "--no-same-owner",
        "-C",
        "/tmp",
        c.dbFile.slice("/tmp/".length),
      ];
    case "restore.files":
      return [
        "tar",
        "-xzf",
        "-",
        "--no-same-owner",
        "--no-overwrite-dir",
        `--exclude=${c.dbFile.slice("/tmp/".length)}`,
        "--exclude=./wp-config.php",
        "-C",
        c.wpPath,
        ...(c.wpContent ? ["./wp-content"] : []),
      ];
    case "db.reset":
      return ["wp", "db", "reset", "--yes", ...SKIP_CODE];
    case "restore.clear-content":
      return [
        "rm",
        "-rf",
        "--",
        `${c.wpPath}/wp-content/plugins`,
        `${c.wpPath}/wp-content/themes`,
        `${c.wpPath}/wp-content/uploads`,
      ];
    case "core.verify-checksums":
      return ["wp", "core", "verify-checksums"];
    case "plugin.verify-checksums":
      return ["wp", "plugin", "verify-checksums", "--all", "--format=json", ...SKIP_CODE];
    case "cli.info":
      return ["wp", "cli", "info", "--format=json"];
    // Emergency operations always skip plugins and themes: they must work on a broken site.
    case "maintenance":
      return ["wp", "maintenance-mode", c.on ? "activate" : "deactivate", ...SKIP_CODE];
    case "maintenance.status":
      return ["wp", "maintenance-mode", "is-active", ...SKIP_CODE];
    case "cache.flush":
      return ["wp", "cache", "flush", ...SKIP_CODE];
    case "db.export":
      return ["wp", "db", "export", c.file];
    case "db.import":
      return ["wp", "db", "import", c.file];
  }
}
