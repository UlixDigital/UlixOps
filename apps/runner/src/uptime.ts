// Uptime probes (Phase 3 step 2, A149). Runs on the runner because only it has egress. One GET
// of each production homepage, the way a visitor arrives: redirects followed, the answer judged
// by its status and whether the page is a PHP / WordPress error. No SSH, no credentials, and
// nothing but the status, timing and a short error leaves the runner.
import {
  bodyLooksCritical,
  isPublicHostname,
  rewriteHealthFetchUrl,
  type UptimeJobResult,
  type UptimeProbe,
  type UptimeProbeResult,
  uptimeStatusOk,
} from "@ulixops/shared";

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 256_000;
/** 10 at a time: 500 probes × 2 attempts × 10 s stays under the API's 4-minute wait. */
const PARALLEL = 10;

export interface UptimeDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Pause before retrying a failed probe (tests pass 0). */
  retryDelayMs?: number;
  timeoutMs?: number;
}

export async function runUptimeProbes(
  probes: UptimeProbe[],
  deps: UptimeDeps = {},
): Promise<UptimeJobResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const results: UptimeProbeResult[] = new Array(probes.length);
  let next = 0;
  const worker = async () => {
    while (next < probes.length) {
      const i = next++;
      const probe = probes[i];
      if (probe) results[i] = await probeWithRetry(probe, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, probes.length) }, worker));
  return { results, durationMs: now() - started };
}

/** One retry after a pause: a single dropped request shouldn't count as a failed check. */
async function probeWithRetry(probe: UptimeProbe, deps: UptimeDeps): Promise<UptimeProbeResult> {
  const first = await probeOnce(probe, deps);
  if (first.ok) return first;
  await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 5_000));
  return probeOnce(probe, deps);
}

export async function probeOnce(
  probe: UptimeProbe,
  deps: UptimeDeps = {},
): Promise<UptimeProbeResult> {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const result = (ok: boolean, status: number | null, error: string | null) => ({
    id: probe.id,
    ok,
    status,
    responseMs: elapsed(),
    error,
  });
  try {
    let current = rewriteHealthFetchUrl(probe.url, probe.sshHost);
    const startHost = new URL(current).hostname;
    for (let hop = 0; ; hop++) {
      const res = await doFetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "UlixOps-Uptime/1",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) return result(false, res.status, "Too many redirects");
        const target = new URL(location, current);
        if (!["http:", "https:"].includes(target.protocol))
          return result(false, res.status, "Redirects to an address that isn't public");
        // Loopback targets are rewritten to the site's own SSH host first; after that, never let
        // a site's redirect point the runner at the hub's own network (A149).
        const next = new URL(rewriteHealthFetchUrl(target.toString(), probe.sshHost));
        if (next.hostname !== startHost && !isPublicHostname(next.hostname))
          return result(false, res.status, "Redirects to an address that isn't public");
        current = next.toString();
        continue;
      }
      const responseMs = elapsed();
      const critical = bodyLooksCritical(await readCapped(res));
      const ok = uptimeStatusOk(res.status, critical);
      return {
        id: probe.id,
        ok,
        status: res.status,
        responseMs,
        error: ok
          ? null
          : critical
            ? "The page shows a PHP / WordPress error"
            : `HTTP ${res.status}`,
      };
    }
  } catch (error) {
    if (controller.signal.aborted)
      return result(false, null, `No answer within ${Math.round(timeoutMs / 1000)} s`);
    return result(false, null, fetchMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

/** The start of the body, enough to spot an error page; the rest is never downloaded. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8");
}

/** Plain-language reason from a fetch failure (undici puts the system code on `cause`). */
function fetchMessage(error: unknown): string {
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const code =
    cause && typeof cause === "object" && "code" in cause ? String(cause.code) : undefined;
  const known: Record<string, string> = {
    ENOTFOUND: "The host name doesn't resolve",
    EAI_AGAIN: "The host name couldn't be looked up",
    ECONNREFUSED: "Connection refused",
    ECONNRESET: "The server closed the connection",
    ETIMEDOUT: "Connection timed out",
    EHOSTUNREACH: "Host unreachable",
    UND_ERR_CONNECT_TIMEOUT: "Connection timed out",
    UND_ERR_SOCKET: "The server closed the connection",
    CERT_HAS_EXPIRED: "The SSL certificate has expired",
    ERR_TLS_CERT_ALTNAME_INVALID: "The SSL certificate doesn't cover this host",
    DEPTH_ZERO_SELF_SIGNED_CERT: "The SSL certificate isn't trusted (self-signed)",
    SELF_SIGNED_CERT_IN_CHAIN: "The SSL certificate isn't trusted (self-signed)",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The SSL certificate isn't trusted",
  };
  if (code && known[code]) return known[code];
  const message = cause instanceof Error ? cause.message : "Request failed";
  return message.replace(/\s+/g, " ").slice(0, 200);
}
