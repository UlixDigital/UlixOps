// `site.errorlog` (A159/A167): read the end of the UlixOps private log (preferred) or
// wp-content/debug.log, then group it. Read-only; secrets redacted.
import {
  ERRORLOG_KEEP_BYTES,
  ERRORLOG_TAIL_BYTES,
  ERRORLOG_TRIM_ABOVE,
  type ErrorLogResult,
  parseErrorLog,
  type SshTarget,
  ULIXOPS_ERROR_LOG_HEADER,
  ulixopsErrorLogFilePath,
  ulixopsErrorLogPluginPath,
} from "@ulixops/shared";
import { muPluginInstalled, readDebugConstants } from "./debuglog";
import { redact } from "./redact";
import type { SshSession } from "./ssh";

export async function readErrorLog(
  session: SshSession,
  target: SshTarget,
  secret: string,
  now: () => number = Date.now,
  opts: { trim?: boolean } = {},
): Promise<ErrorLogResult> {
  const debug = await readDebugConstants(session, target.wpPath).catch(() => null);
  const pluginInstalled = await muPluginInstalled(session, target.wpPath).catch(() => false);
  const ulixopsLog = ulixopsErrorLogFilePath(target.wpPath);
  const debugLog = `${target.wpPath.replace(/\/$/, "")}/wp-content/debug.log`;

  const sftp = await session.sftp();
  try {
    const preferUlixops = pluginInstalled || (await sftp.stat(ulixopsLog));
    const remote = preferUlixops ? ulixopsLog : debugLog;
    const logSource: ErrorLogResult["logSource"] = preferUlixops
      ? "ulixops"
      : (await sftp.stat(debugLog))
        ? "debug.log"
        : "none";

    const info = await sftp.stat(remote);
    if (!info || info.isDirectory)
      return {
        debug,
        pluginInstalled,
        logSource: pluginInstalled ? "ulixops" : "none",
        fileFound: false,
        sizeBytes: 0,
        modifiedAt: null,
        truncated: false,
        groups: [],
      };

    let size = info.size;
    // Only trim the UlixOps-managed private log (never touch a host's own debug.log).
    if (opts.trim && preferUlixops && size > ERRORLOG_TRIM_ABOVE) {
      const tail = await sftp.readFileTail(remote, ERRORLOG_KEEP_BYTES);
      const cut = tail.indexOf(0x0a);
      const kept = cut >= 0 ? tail.subarray(cut + 1) : tail;
      // Keep the PHP exit header so a trimmed log still can't be downloaded as text (A168).
      const withHeader = Buffer.concat([Buffer.from(ULIXOPS_ERROR_LOG_HEADER), kept]);
      await sftp.writeFile(remote, withHeader);
      size = withHeader.length;
    }
    const data = await sftp.readFileTail(remote, ERRORLOG_TAIL_BYTES);
    const truncated = size > data.length;
    const groups = parseErrorLog(data.toString("utf8"), new Date(now()), {
      startsMidFile: truncated,
      redact: (s) => redact(s, [secret], 1000).replace("… (truncated)", ""),
    });
    const last = groups.reduce<string | null>(
      (max, g) => (g.lastAt && (!max || g.lastAt > max) ? g.lastAt : max),
      null,
    );
    return {
      debug,
      pluginInstalled,
      logSource,
      fileFound: true,
      sizeBytes: size,
      modifiedAt: last,
      truncated,
      groups,
    };
  } finally {
    sftp.close();
  }
}

/** Exported for tests that assert the plugin path. */
export { ulixopsErrorLogPluginPath };
