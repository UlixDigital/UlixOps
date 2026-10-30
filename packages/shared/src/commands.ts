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
/** Absolute WordPress path on the server; no "..", no spaces or shell characters. */
export const WpPath = z.string().regex(/^\/(?!.*\.\.)[A-Za-z0-9._/-]{0,250}$/);

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
  z.object({ op: z.literal("core.version") }),
  z.object({ op: z.literal("cli.info") }),
  z.object({ op: z.literal("maintenance"), on: z.boolean() }),
  z.object({ op: z.literal("maintenance.status") }),
  z.object({ op: z.literal("cache.flush") }),
  z.object({ op: z.literal("db.export"), file: TmpUlixopsFile }),
  z.object({ op: z.literal("db.import"), file: TmpUlixopsFile }),
]);
export type Command = z.infer<typeof Command>;

// Returns an argv array (never a shell string). The runner passes args safely.
// With `wpPath`, WP-CLI is pointed at that install (`--path=`), validated like every argument.
export function toArgv(input: unknown, opts: { wpPath?: string } = {}): string[] {
  const argv = commandArgv(Command.parse(input));
  if (opts.wpPath === undefined) return argv;
  return ["wp", `--path=${WpPath.parse(opts.wpPath)}`, ...argv.slice(1)];
}

const SKIP_CODE = ["--skip-plugins", "--skip-themes"];
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
    case "core.version":
      return ["wp", "core", "version"];
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
