// `site.integrity` (A144): WordPress core and WordPress.org plugins against their official
// checksums, with WP-CLI over SSH. Read-only on the site. The core check runs before WordPress
// loads, so it still works when a plugin or a damaged core file breaks the site.
import {
  type IntegrityFinding,
  type IntegrityJobResult,
  MAX_INTEGRITY_FINDINGS,
  type SshTarget,
  toArgv,
} from "@ulixops/shared";
import { z } from "zod";
import { parseJsonArray } from "./inventory";
import { redact } from "./redact";
import type { SshSession } from "./ssh";

const CORE_TIMEOUT_MS = 120_000;
const PLUGINS_TIMEOUT_MS = 300_000;

const CORE_LINES: [RegExp, IntegrityFinding["issue"]][] = [
  [/^Warning: File doesn't verify against checksum: (.+)$/, "modified"],
  [/^Warning: File doesn't exist: (.+)$/, "missing"],
  [/^Warning: File should not exist: (.+)$/, "added"],
];

/** Findings from `wp core verify-checksums` (warnings go to stderr, one per file). */
export function parseCoreOutput(text: string): IntegrityFinding[] {
  const out: IntegrityFinding[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    for (const [re, issue] of CORE_LINES) {
      const m = re.exec(line);
      if (m?.[1]) out.push({ scope: "core", component: "wordpress", path: m[1].trim(), issue });
    }
  }
  return out;
}

const PluginRow = z.object({ plugin_name: z.string(), file: z.string(), message: z.string() });

const PLUGIN_ISSUES: [RegExp, IntegrityFinding["issue"]][] = [
  [/does not match/i, "modified"],
  [/was added/i, "added"],
  [/missing/i, "missing"],
];

/** Findings, verifiable count and skipped plugins from `wp plugin verify-checksums --all`. */
export function parsePluginOutput(
  stdout: string,
  stderr: string,
): { findings: IntegrityFinding[]; unverifiable: string[]; verified: number | null } {
  const findings: IntegrityFinding[] = [];
  for (const raw of parseJsonArray(stdout) ?? []) {
    const row = PluginRow.safeParse(raw);
    if (!row.success) continue;
    const issue = PLUGIN_ISSUES.find(([re]) => re.test(row.data.message))?.[1] ?? "modified";
    // The file within the plugin: a single-file plugin (hello.php) has no folder of its own.
    findings.push({
      scope: "plugin",
      component: row.data.plugin_name.slice(0, 200),
      path: row.data.file.slice(0, 1000),
      issue,
    });
  }
  // WP-CLI prints its summary on stdout when all is well and on stderr when not: read both.
  const text = `${stdout}\n${stderr}`;
  const unverifiable = [
    ...new Set(
      [...text.matchAll(/Could not retrieve the checksums for version .+? of plugin ([^,\s]+)/g)]
        .map((m) => m[1] ?? "")
        .filter(Boolean),
    ),
  ];
  // "Success: Verified 2 of 4 plugins (2 skipped)." / "Error: Only verified 1 of 4 plugins …"
  const count = /[Vv]erified (\d+) of (\d+) plugins/.exec(text);
  const failed = /\((\d+) failed/.exec(text);
  const verified = count ? Number(count[1]) + (failed ? Number(failed[1]) : 0) : null;
  return { findings, unverifiable, verified };
}

export async function runIntegrityCheck(
  session: SshSession,
  target: SshTarget,
  secret: string,
  now: () => number = Date.now,
): Promise<IntegrityJobResult & { hostKeyMismatch: false }> {
  const started = now();
  const clean = (text: string) => redact(text.trim(), [secret], 500);
  const run = (op: "core.verify-checksums" | "plugin.verify-checksums", timeout: number) =>
    session.exec(toArgv({ op }, { wpPath: target.wpPath }), timeout);
  const notes: string[] = [];

  // Core: exit 0 = verifies (extra files still listed as warnings), 1 = differences found.
  const core = await run("core.verify-checksums", CORE_TIMEOUT_MS);
  const coreText = `${core.stdout}\n${core.stderr}`;
  const coreFindings = parseCoreOutput(coreText);
  const coreChecked =
    core.exitCode === 0 ||
    (core.exitCode === 1 && /doesn't verify against checksums/.test(coreText));
  if (!coreChecked)
    notes.push(
      clean(
        `WordPress core couldn't be checked (exit ${core.exitCode}): ${core.stderr || core.stdout}`,
      ),
    );

  // Plugins: exit 0 = all verified, 1 = some differ; anything else (e.g. 255) = didn't run.
  const plugins = await run("plugin.verify-checksums", PLUGINS_TIMEOUT_MS);
  const parsed = parsePluginOutput(plugins.stdout, plugins.stderr);
  const pluginsChecked =
    (plugins.exitCode === 0 || plugins.exitCode === 1) && parsed.verified !== null;
  if (!pluginsChecked)
    notes.push(
      clean(
        `Plugins couldn't be checked (exit ${plugins.exitCode}); WordPress may not load: ${
          (plugins.stderr || plugins.stdout).split("\n").find((l) => l.trim()) ?? ""
        }`,
      ),
    );

  const findings = [...coreFindings, ...(pluginsChecked ? parsed.findings : [])].slice(
    0,
    MAX_INTEGRITY_FINDINGS,
  );
  const summary = [
    coreChecked
      ? coreFindings.length
        ? `WordPress core: ${coreFindings.length} file${coreFindings.length === 1 ? "" : "s"} differ.`
        : "WordPress core matches its checksums."
      : "",
    pluginsChecked
      ? `${parsed.verified} plugin${parsed.verified === 1 ? "" : "s"} checked${
          parsed.findings.length
            ? `, ${parsed.findings.length} changed file${parsed.findings.length === 1 ? "" : "s"}`
            : ", no changes"
        }${parsed.unverifiable.length ? `; ${parsed.unverifiable.length} not on WordPress.org (not verifiable)` : ""}.`
      : "",
    ...notes,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    hostKeyMismatch: false,
    hostKey: session.hostKey,
    coreChecked,
    pluginsChecked,
    verifiedPlugins: pluginsChecked ? (parsed.verified ?? 0) : 0,
    unverifiable: pluginsChecked ? parsed.unverifiable.slice(0, 1000) : [],
    findings,
    detail: summary.slice(0, 2000),
    durationMs: now() - started,
  };
}
