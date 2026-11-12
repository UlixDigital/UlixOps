// Site inventory (spec 6.1, Build Order step 6): versions, plugins, themes and maintenance mode,
// read with allowlisted WP-CLI commands only. Works on a broken site: when plugins crash
// WP-CLI, the lists are read again with plugins and themes skipped (agent decision A54).
import {
  type Command,
  CoreVersion,
  phpVersionCompare,
  type InventoryItem,
  MAX_INVENTORY_ITEMS,
  type SiteInventoryResult,
  type SshTarget,
  toArgv,
} from "@ulixops/shared";
import { z } from "zod";
import { maintenanceFilePresent } from "./maintenance";
import { redact } from "./redact";
import type { SshSession } from "./ssh";

const CliInfo = z.object({ wp_cli_version: z.string(), php_version: z.string() });

// What `wp plugin list` / `wp theme list --fields=name,title,status,version,update,update_version`
// prints. Read leniently, then normalised and capped below.
const RawItem = z.object({
  name: z.string().min(1),
  title: z.string().nullish(),
  status: z.string(),
  version: z.string().nullish(),
  update: z.string().nullish(),
  update_version: z.string().nullish(),
});
const STATUSES = new Set(["active", "inactive", "active-network", "must-use", "dropin", "parent"]);

/** Thrown when the site can't be read at all; the message is already redacted. */
export class InventoryError extends Error {}

export async function readInventory(
  session: SshSession,
  target: SshTarget,
  secret: string,
  now: () => number,
  opts: { checkUpdates?: boolean } = {},
): Promise<SiteInventoryResult> {
  const checkUpdates = opts.checkUpdates === true;
  const started = now();
  const warnings: string[] = [];
  const clean = (text: string, max = 500) => redact(text.trim(), [secret], max);
  // WP Engine / heavy sites: cli.info alone can take tens of seconds (A115).
  const run = (command: Command, timeoutMs = 45_000) =>
    session.exec(toArgv(command, { wpPath: target.wpPath }), timeoutMs);

  // Prove WP-CLI works first; then run the rest in parallel (A112).
  const info = await run({ op: "cli.info" });
  const cli = info.exitCode === 0 ? CliInfo.safeParse(parseJson(info.stdout)) : null;
  if (!cli?.success)
    throw new InventoryError(
      clean(`WP-CLI not available (exit ${info.exitCode}): ${info.stderr || info.stdout}`),
    );

  // Fast refresh (A114/A115): list with --skip-plugins/--skip-themes so we never load
  // plugin code (that was timing out at 30s on slow PHP 7.4 WP Engine installs).
  // Check for updates still loads plugins first (update info), then falls back to safe (A54).
  const listSafeFirst = !checkUpdates;
  const [core, pluginsFirst, themesFirst, maintenanceCheck, coreUpdate] = await Promise.all([
    run({ op: "core.version" }),
    list(run, "plugin.list", listSafeFirst, checkUpdates),
    list(run, "theme.list", listSafeFirst, checkUpdates),
    readMaintenance(session, target, run, clean),
    checkUpdates ? readCoreUpdate(run, clean) : Promise.resolve({ version: null, warning: null }),
  ]);

  const wpVersion = core.stdout.trim();
  if (core.exitCode !== 0 || !/^\d+\.\d+(\.\d+)?/.test(wpVersion))
    throw new InventoryError(
      clean(`WordPress not found at ${target.wpPath}: ${core.stderr || core.stdout}`),
    );

  let safeMode = false;
  let plugins = pluginsFirst;
  let themes = themesFirst;
  if (!plugins.ok) {
    if (!checkUpdates) {
      throw new InventoryError(clean(`Plugins could not be listed: ${plugins.error}`));
    }
    safeMode = true;
    warnings.push(
      clean(`WP-CLI failed with plugins loaded, so they were skipped: ${plugins.error}`),
    );
    // Re-read both lists without loading plugin/theme code (A54).
    const [pluginsSafe, themesSafe] = await Promise.all([
      list(run, "plugin.list", true, checkUpdates),
      list(run, "theme.list", true, checkUpdates),
    ]);
    plugins = pluginsSafe;
    themes = themesSafe;
    if (!plugins.ok)
      throw new InventoryError(clean(`Plugins could not be listed: ${plugins.error}`));
  }
  if (!themes.ok) warnings.push(clean(`Themes could not be listed: ${themes.error}`));
  warnings.push(...maintenanceCheck.warnings);
  if (coreUpdate.warning) warnings.push(coreUpdate.warning);
  if (!checkUpdates) {
    warnings.push("Update availability was not checked (use Check for updates).");
  }

  const skipped = [...plugins.skipped, ...(themes.ok ? themes.skipped : [])];
  if (skipped.length > 0)
    warnings.push(clean(`Skipped entries WP-CLI reported oddly: ${skipped.join(", ")}`));

  return {
    hostKeyMismatch: false,
    hostKey: session.hostKey,
    wpVersion: wpVersion.slice(0, 50),
    phpVersion: cli.data.php_version.slice(0, 50),
    wpCliVersion: cli.data.wp_cli_version.slice(0, 50),
    plugins: plugins.items,
    themes: themes.ok ? themes.items : [],
    maintenance: maintenanceCheck.maintenance,
    safeMode,
    warnings: warnings.slice(0, 10),
    durationMs: now() - started,
    updatesChecked: checkUpdates,
    coreUpdateVersion: coreUpdate.version,
  };
}

const CoreUpdates = z.array(z.object({ version: z.string(), update_type: z.string().nullish() }));

/** Newest WordPress release `wp core check-update` offers (A135); null when current. */
async function readCoreUpdate(
  run: (
    command: Command,
    timeoutMs?: number,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  clean: (text: string, max?: number) => string,
): Promise<{ version: string | null; warning: string | null }> {
  const out = await run({ op: "core.check-update" }, 60_000);
  if (out.exitCode !== 0)
    return {
      version: null,
      warning: clean(`WordPress core update check failed: ${out.stderr || out.stdout}`),
    };
  // WP-CLI prints nothing (or a "Success: WordPress is at the latest version." line) when current.
  const parsed = CoreUpdates.safeParse(parseJsonArray(out.stdout) ?? []);
  if (!parsed.success) return { version: null, warning: null };
  const offered = parsed.data
    .map((u) => u.version.trim())
    .filter((v) => CoreVersion.safeParse(v).success)
    .sort(phpVersionCompare);
  return { version: offered.at(-1) ?? null, warning: null };
}

async function readMaintenance(
  session: SshSession,
  target: SshTarget,
  run: (
    command: Command,
    timeoutMs?: number,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  clean: (text: string, max?: number) => string,
): Promise<{ maintenance: boolean | null; warnings: string[] }> {
  const warnings: string[] = [];
  // `maintenance-mode is-active` answers with its exit code: 0 on, 1 off.
  // Also treat a leftover `.maintenance` file as on (stuck plugin update — A111).
  const status = await run({ op: "maintenance.status" });
  let maintenance = status.exitCode === 0 ? true : status.exitCode === 1 ? false : null;
  if (maintenance === null)
    warnings.push(clean(`Maintenance mode unknown (exit ${status.exitCode}): ${status.stderr}`));
  try {
    const sftp = await session.sftp();
    try {
      if (await maintenanceFilePresent(sftp, target.wpPath)) {
        if (maintenance === false) {
          warnings.push(
            "Leftover .maintenance file from a stuck update (visitors may see the maintenance page)",
          );
        }
        maintenance = true;
      }
    } finally {
      sftp.close();
    }
  } catch (error) {
    warnings.push(
      clean(
        `Could not check .maintenance file: ${error instanceof Error ? error.message : "unknown"}`,
      ),
    );
  }
  return { maintenance, warnings };
}

type ListResult =
  { ok: true; items: InventoryItem[]; skipped: string[] } | { ok: false; error: string };

async function list(
  run: (
    command: Command,
    timeoutMs?: number,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  op: "plugin.list" | "theme.list",
  safe: boolean,
  checkUpdates: boolean,
): Promise<ListResult> {
  // Update checks contact the update servers; even safe lists can be slow on WP Engine (A115).
  const result = await run(
    { op, safe, updates: checkUpdates ? undefined : false },
    checkUpdates ? 120_000 : 90_000,
  );
  if (result.exitCode !== 0)
    return { ok: false, error: `exit ${result.exitCode}: ${result.stderr || result.stdout}` };
  const raw = parseJsonArray(result.stdout);
  if (!raw)
    return { ok: false, error: `exit ${result.exitCode}: ${result.stderr || result.stdout}` };
  // One odd WP-CLI row must not fail the whole inventory (WP Engine staging quirk).
  const accepted: z.infer<typeof RawItem>[] = [];
  const skipped: string[] = [];
  for (const entry of raw) {
    const parsed = RawItem.safeParse(entry);
    if (!parsed.success) {
      skipped.push(itemName(entry));
      continue;
    }
    accepted.push(parsed.data);
  }
  return normalise(accepted, skipped);
}

export function normalise(
  raw: z.infer<typeof RawItem>[],
  alreadySkipped: string[] = [],
): ListResult & { ok: true } {
  const items: InventoryItem[] = [];
  const skipped: string[] = [...alreadySkipped];
  for (const entry of raw.slice(0, MAX_INVENTORY_ITEMS)) {
    if (!STATUSES.has(entry.status)) {
      skipped.push(entry.name.slice(0, 100));
      continue;
    }
    const update = entry.update === "available" ? entry.update_version || "newer version" : null;
    items.push({
      name: entry.name.slice(0, 200),
      title: (entry.title ?? "").slice(0, 300),
      status: entry.status as InventoryItem["status"],
      version: (entry.version ?? "").slice(0, 50),
      updateVersion: update?.slice(0, 50) ?? null,
    });
  }
  return { ok: true, items, skipped: skipped.slice(0, 20) };
}

function itemName(entry: unknown): string {
  if (entry && typeof entry === "object" && "name" in entry) {
    const name = (entry as { name: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name.slice(0, 100);
  }
  return "unknown";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Pull a JSON array out of WP-CLI stdout (PHP notices before/after are common on real hosts). */
export function parseJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  const attempts = [trimmed];
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const candidate of attempts) {
    const parsed = parseJson(candidate);
    if (Array.isArray(parsed)) return parsed;
    // Rare broken printers: objects jammed together without commas.
    if (candidate.includes("}{") || /\}\s+\{/.test(candidate)) {
      const repaired = parseJson(candidate.replace(/\}\s*\{/g, "},{"));
      if (Array.isArray(repaired)) return repaired;
    }
  }
  return null;
}
