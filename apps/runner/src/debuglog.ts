// PHP error logging switch (A160 → A167/A168): install/remove an UlixOps must-use plugin that
// writes to a private wp-content/ulixops-logs/php-errors.php (PHP exit header so nginx hosts
// like WP Engine don't serve the log). No wp-config.php edits.
import {
  type DebugConstants,
  type DebugLogJobResult,
  DebugValue,
  DEBUG_CONSTANTS,
  type DebugConstant,
  ERRORLOG_KEEP_BYTES,
  healthFetchOrigin,
  type SshTarget,
  toArgv,
  ULIXOPS_ERROR_LOG_DIR,
  ULIXOPS_ERROR_LOG_FILE,
  ULIXOPS_ERROR_LOG_HEADER,
  ULIXOPS_ERROR_LOG_PLUGIN_SOURCE,
  ulixopsErrorLogDirPath,
  ulixopsErrorLogFilePath,
  ulixopsErrorLogLegacyFilePath,
  ulixopsErrorLogPluginPath,
} from "@ulixops/shared";
import { redact } from "./redact";
import type { SshSession } from "./ssh";

const WP_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const MARKER = "UlixOps: PHP error logging switched on";

const HTACCESS = `# UlixOps — deny web access to PHP error logs
<IfModule mod_authz_core.c>
\tRequire all denied
</IfModule>
<IfModule !mod_authz_core.c>
\tOrder deny,allow
\tDeny from all
</IfModule>
`;

/** Each constant's value; null if a read failed for a reason other than "not defined". */
export async function readDebugConstants(
  session: SshSession,
  wpPath: string,
): Promise<DebugConstants | null> {
  const out: Partial<Record<DebugConstant, DebugConstants[DebugConstant]>> = {};
  for (const name of DEBUG_CONSTANTS) {
    const r = await session.exec(toArgv({ op: "config.get", name }, { wpPath }), WP_TIMEOUT_MS);
    if (r.exitCode !== 0) {
      if (/not defined/i.test(`${r.stderr}${r.stdout}`)) {
        out[name] = null;
        continue;
      }
      return null;
    }
    try {
      const value = DebugValue.safeParse(JSON.parse(r.stdout.trim()));
      out[name] = value.success ? value.data : null;
    } catch {
      return null;
    }
  }
  return {
    WP_DEBUG: out.WP_DEBUG ?? null,
    WP_DEBUG_LOG: out.WP_DEBUG_LOG ?? null,
    WP_DEBUG_DISPLAY: out.WP_DEBUG_DISPLAY ?? null,
  };
}

export async function muPluginInstalled(session: SshSession, wpPath: string): Promise<boolean> {
  const sftp = await session.sftp();
  try {
    const st = await sftp.stat(ulixopsErrorLogPluginPath(wpPath));
    return Boolean(st && !st.isDirectory);
  } finally {
    sftp.close();
  }
}

/** True when anyone can download the log from the site. */
async function downloadable(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "UlixOps-HealthCheck/1" },
    });
    if (res.status !== 200) return false;
    const body = (await res.text()).slice(0, 8192);
    return body.includes(MARKER) || /^\[\d{2}-[A-Z][a-z]{2}-\d{4} /m.test(body);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const stamp = (d: Date) => {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `[${p(d.getUTCDate())}-${m[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC]`;
};

/** Logical "on" constants for the hub UI (wp-config may be untouched). */
const LOGICAL_ON: DebugConstants = {
  WP_DEBUG: true,
  WP_DEBUG_LOG: true,
  WP_DEBUG_DISPLAY: false,
};

export async function switchDebugLog(
  session: SshSession,
  target: SshTarget,
  job: { action: "enable" | "disable"; siteUrl: string; restore?: DebugConstants },
  secret: string,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<DebugLogJobResult & { hostKeyMismatch: false }> {
  const wpPath = target.wpPath;
  const base = {
    hostKeyMismatch: false as const,
    hostKey: session.hostKey,
    exposed: false,
    method: "mu-plugin" as const,
  };
  const clean = (s: string) => redact(s, [secret], 900);
  const previous = await readDebugConstants(session, wpPath);
  const pluginPath = ulixopsErrorLogPluginPath(wpPath);
  const logDir = ulixopsErrorLogDirPath(wpPath);
  const logFile = ulixopsErrorLogFilePath(wpPath);
  const legacyLog = ulixopsErrorLogLegacyFilePath(wpPath);
  const publicPath = `/wp-content/${ULIXOPS_ERROR_LOG_DIR}/${ULIXOPS_ERROR_LOG_FILE}`;

  try {
    if (job.action === "disable") {
      const sftp = await session.sftp();
      try {
        await sftp.unlink(pluginPath).catch(() => undefined);
      } finally {
        sftp.close();
      }
      const stillThere = await muPluginInstalled(session, wpPath);
      if (stillThere)
        return {
          ...base,
          ok: false,
          previous,
          current: previous,
          pluginInstalled: true,
          detail: "Could not remove the UlixOps error-log plugin from mu-plugins.",
        };
      return {
        ...base,
        ok: true,
        previous,
        current: previous,
        pluginInstalled: false,
        detail:
          "Error logging switched off: UlixOps mu-plugin removed. The private log file was left in place.",
      };
    }

    // Enable: install mu-plugin + private log dir (never touch wp-config.php).
    const sftp = await session.sftp();
    try {
      await sftp.mkdirp(`${wpPath.replace(/\/$/, "")}/wp-content/mu-plugins`);
      await sftp.mkdirp(logDir);
      await sftp.writeFile(`${logDir}/.htaccess`, Buffer.from(HTACCESS));
      await sftp.writeFile(`${logDir}/index.html`, Buffer.from(""));
      // Drop the A167 .log so nginx hosts can't keep serving an old public copy.
      await sftp.unlink(legacyLog).catch(() => undefined);
      await sftp.writeFile(pluginPath, Buffer.from(ULIXOPS_ERROR_LOG_PLUGIN_SOURCE));
      const existing = await sftp.stat(logFile);
      if (!existing) {
        await sftp.writeFile(
          logFile,
          Buffer.from(
            `${ULIXOPS_ERROR_LOG_HEADER}${stamp(new Date((deps.now ?? Date.now)()))} ${MARKER}\n`,
          ),
        );
      } else {
        // Re-seed if the PHP exit header is missing (required for web safety on nginx).
        // Use readFileHead — readFile(max) fails when the file is larger than max (WP Engine
        // shell-fs: "Remote output exceeds N bytes", A170).
        const head = await sftp.readFileHead(logFile, 128);
        if (!head.toString("utf8").includes("exit;")) {
          const rest = await sftp.readFileTail(logFile, ERRORLOG_KEEP_BYTES);
          await sftp.writeFile(
            logFile,
            Buffer.concat([Buffer.from(ULIXOPS_ERROR_LOG_HEADER), rest]),
          );
        }
      }
    } finally {
      sftp.close();
    }

    const installed = await muPluginInstalled(session, wpPath);
    if (!installed)
      return {
        ...base,
        ok: false,
        previous,
        current: previous,
        pluginInstalled: false,
        detail: "The UlixOps mu-plugin could not be written to mu-plugins.",
      };

    const url = `${healthFetchOrigin(job.siteUrl, target.host)}${publicPath}`;
    if (await downloadable(url, deps.fetchImpl ?? fetch)) {
      const fs = await session.sftp();
      try {
        await fs.unlink(pluginPath).catch(() => undefined);
      } finally {
        fs.close();
      }
      return {
        ...base,
        ok: false,
        exposed: true,
        previous,
        current: previous,
        pluginInstalled: false,
        detail: `Anyone could download ${new URL(job.siteUrl).origin}${publicPath}, so the plugin was removed again. The log must be a PHP file the host executes (not a plain download). Contact host support if this keeps happening.`,
      };
    }

    return {
      ...base,
      ok: true,
      previous,
      current: LOGICAL_ON,
      pluginInstalled: true,
      detail:
        "Error logging switched on via UlixOps mu-plugin. Errors go to wp-content/ulixops-logs/php-errors.php (not shown on pages, not downloadable).",
    };
  } catch (error) {
    const fs = await session.sftp();
    try {
      await fs.unlink(pluginPath).catch(() => undefined);
    } finally {
      fs.close();
    }
    return {
      ...base,
      ok: false,
      previous,
      current: null,
      pluginInstalled: false,
      detail: clean(error instanceof Error ? error.message : "The change failed."),
    };
  }
}
