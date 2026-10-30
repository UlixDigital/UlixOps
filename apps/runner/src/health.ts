// HTTP (+ optional debug.log) health checks for a site (spec §6.6). Runs on the runner because
// only it has egress to sites (agent decision A76).
import {
  bodyLooksCritical,
  type HealthErrorLogResult,
  type HealthJobResult,
  type HealthUrlResult,
  healthUrlRole,
  rewriteHealthFetchUrl,
  type SshTarget,
} from "@ulixops/shared";
import type { SshSession } from "./ssh";

const MAX_BODY_BYTES = 256_000;
const MAX_DEBUG_LOG_BYTES = 64_000;
const FATAL_LOG = /\b(?:PHP )?(?:Fatal|Parse) error\b|\bUncaught (?:Error|Exception)\b/i;

export async function runHealthCheck(
  session: SshSession,
  target: SshTarget,
  opts: {
    urls: string[];
    origin: string;
    thresholdMs: number;
    checkErrorLog: boolean;
  },
  now: () => number = Date.now,
): Promise<HealthJobResult & { hostKeyMismatch: false }> {
  const started = now();
  const urlResults: HealthUrlResult[] = [];
  for (const url of opts.urls) {
    urlResults.push(await checkUrl(url, opts.origin, target.host, opts.thresholdMs, now));
  }

  const errorLog = opts.checkErrorLog
    ? await checkErrorLog(session, target.wpPath)
    : ({
        checked: false,
        ok: true,
        skipped: true,
        detail: "Error-log check disabled in Settings",
        fatalLines: 0,
      } satisfies HealthErrorLogResult);

  const urlFailures = urlResults.filter((u) => !u.ok).length;
  const ok = urlFailures === 0 && errorLog.ok;
  const parts = [
    `${urlResults.length - urlFailures}/${urlResults.length} URLs ok`,
    errorLog.skipped
      ? `error log: ${errorLog.detail}`
      : errorLog.ok
        ? "error log: clean"
        : `error log: ${errorLog.fatalLines} fatal line(s)`,
  ];
  return {
    hostKeyMismatch: false,
    ok,
    hostKey: session.hostKey,
    urls: urlResults,
    errorLog,
    thresholdMs: opts.thresholdMs,
    durationMs: now() - started,
    summary: (ok ? "Healthy. " : "Unhealthy. ") + parts.join("; "),
  };
}

async function checkUrl(
  url: string,
  origin: string,
  sshHost: string,
  thresholdMs: number,
  now: () => number,
): Promise<HealthUrlResult> {
  const role = healthUrlRole(url, origin);
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), thresholdMs + 1_000);
  try {
    const res = await fetchFollowingRedirects(url, sshHost, controller.signal);
    const durationMs = now() - started;
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.subarray(0, MAX_BODY_BYTES).toString("utf8");
    const criticalText = bodyLooksCritical(text);

    if (durationMs > thresholdMs) {
      return {
        url,
        role,
        ok: false,
        status: res.status,
        durationMs,
        detail: `Slower than ${thresholdMs} ms (${durationMs} ms)`,
        criticalText,
      };
    }
    if (criticalText) {
      return {
        url,
        role,
        ok: false,
        status: res.status,
        durationMs,
        detail: "Response body looks like a PHP / WordPress critical error",
        criticalText: true,
      };
    }
    if (role === "wp-admin") {
      // wp-admin often redirects to wp-login.php; accept 200 with a login form marker.
      const looksLikeLogin =
        /name=["']log["']/i.test(text) ||
        /id=["']user_login["']/i.test(text) ||
        /wp-login\.php/i.test(text) ||
        /wordpress/i.test(text);
      if (res.status >= 200 && res.status < 400 && looksLikeLogin) {
        return {
          url,
          role,
          ok: true,
          status: res.status,
          durationMs,
          detail: "wp-admin login page loads",
          criticalText: false,
        };
      }
      if (res.status >= 200 && res.status < 400 && !looksLikeLogin) {
        // Still up: dashboard when already cookied is rare for the runner; treat 2xx/3xx as ok
        // if no critical text (agent decision A78).
        return {
          url,
          role,
          ok: true,
          status: res.status,
          durationMs,
          detail: "wp-admin responded",
          criticalText: false,
        };
      }
      return {
        url,
        role,
        ok: false,
        status: res.status,
        durationMs,
        detail: `wp-admin returned HTTP ${res.status}`,
        criticalText: false,
      };
    }
    if (res.status !== 200) {
      return {
        url,
        role,
        ok: false,
        status: res.status,
        durationMs,
        detail: `Expected HTTP 200, got ${res.status}`,
        criticalText: false,
      };
    }
    return {
      url,
      role,
      ok: true,
      status: res.status,
      durationMs,
      detail: "OK",
      criticalText: false,
    };
  } catch (error) {
    const durationMs = now() - started;
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      url,
      role,
      ok: false,
      status: null,
      durationMs,
      detail: aborted
        ? `Timed out after ${thresholdMs} ms`
        : error instanceof Error
          ? error.message.slice(0, 300)
          : "Request failed",
      criticalText: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Follow redirects, rewriting loopback / :8080 targets to the SSH host (A80). */
async function fetchFollowingRedirects(
  startUrl: string,
  sshHost: string,
  signal: AbortSignal,
): Promise<Response> {
  let current = rewriteHealthFetchUrl(startUrl, sshHost);
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "UlixOps-HealthCheck/1",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
    });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    const next = rewriteHealthFetchUrl(new URL(location, current).toString(), sshHost);
    current = next;
  }
  throw new Error("Too many redirects");
}

async function checkErrorLog(session: SshSession, wpPath: string): Promise<HealthErrorLogResult> {
  const remote = `${wpPath.replace(/\/$/, "")}/wp-content/debug.log`;
  const sftp = await session.sftp();
  try {
    const info = await sftp.stat(remote);
    if (!info || info.isDirectory) {
      return {
        checked: true,
        ok: true,
        skipped: true,
        detail: "No wp-content/debug.log (skipped)",
        fatalLines: 0,
      };
    }
    const data = await sftp.readFileTail(remote, MAX_DEBUG_LOG_BYTES);
    const text = data.toString("utf8");
    const lines = text.split(/\r?\n/).filter((line) => FATAL_LOG.test(line));
    if (lines.length === 0) {
      return {
        checked: true,
        ok: true,
        skipped: false,
        detail: "No recent fatal/parse lines in debug.log",
        fatalLines: 0,
      };
    }
    return {
      checked: true,
      ok: false,
      skipped: false,
      detail: `Found ${lines.length} fatal/parse line(s) in debug.log`,
      fatalLines: Math.min(lines.length, 100),
    };
  } catch (error) {
    return {
      checked: true,
      ok: true,
      skipped: true,
      detail:
        error instanceof Error
          ? `Could not read debug.log (${error.message.slice(0, 120)}); skipped`
          : "Could not read debug.log; skipped",
      fatalLines: 0,
    };
  } finally {
    sftp.close();
  }
}
