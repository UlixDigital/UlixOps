// `site.visual.capture` (A163): hand page URLs to the Playwright sidecar via visual-work,
// wait for result.json, return the capture/diff summary. No SSH, no vault — public pages only.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isPublicHostname,
  rewriteHealthFetchUrl,
  type VisualCaptureMode,
  type VisualCaptureResult,
  type VisualPageRequest,
  type VisualPageResult,
  VisualSidecarResult,
  visualPageSlug,
} from "@ulixops/shared";
import { redact } from "./redact";

const CAPTURE_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 1_500;

export interface VisualDeps {
  workDir: string;
  storeDir: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

function isAllowedHost(hostname: string, sshHost: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ssh = sshHost.toLowerCase();
  if (host === ssh) return true;
  if (isPublicHostname(host)) return true;
  // Loopback is rewritten before this check; still refuse anything else private.
  return false;
}

/** Rewrite and validate each page URL the way uptime probes do (A149 / A163). */
export function prepareVisualPages(
  pages: VisualPageRequest[],
  sshHost: string,
): { ok: true; pages: VisualPageRequest[] } | { ok: false; detail: string } {
  const out: VisualPageRequest[] = [];
  for (const page of pages) {
    let current: URL;
    try {
      current = new URL(rewriteHealthFetchUrl(page.url, sshHost));
    } catch {
      return { ok: false, detail: `Bad URL for ${page.path}` };
    }
    if (!["http:", "https:"].includes(current.protocol))
      return { ok: false, detail: `Unsupported protocol for ${page.path}` };
    if (!isAllowedHost(current.hostname, sshHost))
      return { ok: false, detail: `Host for ${page.path} isn't public` };
    out.push({
      path: page.path,
      role: page.role,
      url: current.toString(),
    });
  }
  return { ok: true, pages: out };
}

async function readIfPresent(file: string, max: number): Promise<string | null> {
  try {
    const data = await readFile(file);
    return data.subarray(0, max).toString("utf8");
  } catch {
    return null;
  }
}

export async function runVisualCapture(
  input: {
    checkId: string;
    mode: VisualCaptureMode;
    pages: VisualPageRequest[];
    sshHost: string;
    viewportWidth: number;
    viewportHeight: number;
    maxDiffPercent: number;
    pixelThreshold: number;
  },
  deps: VisualDeps,
): Promise<VisualCaptureResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  const clean = (text: string) => redact(text.trim(), [], 1500);

  if (!/^[a-z0-9]{1,64}$/.test(input.checkId))
    return {
      ok: false,
      mode: input.mode,
      pages: [],
      changed: false,
      detail: "Invalid check id",
      durationMs: now() - started,
    };

  const prepared = prepareVisualPages(input.pages, input.sshHost);
  if (!prepared.ok)
    return {
      ok: false,
      mode: input.mode,
      pages: [],
      changed: false,
      detail: prepared.detail,
      durationMs: now() - started,
    };

  const workDir = path.join(deps.workDir, input.checkId);
  const storeDir = path.join(deps.storeDir, input.checkId);
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(storeDir, { recursive: true, mode: 0o750 });

  const request = {
    id: input.checkId,
    mode: input.mode,
    pages: prepared.pages,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    maxDiffPercent: input.maxDiffPercent,
    pixelThreshold: input.pixelThreshold,
    storeDir,
  };

  try {
    await writeFile(path.join(workDir, "request.json"), JSON.stringify(request), {
      mode: 0o600,
    });

    const deadline = now() + (deps.timeoutMs ?? CAPTURE_TIMEOUT_MS);
    let done: string | null = null;
    while (done === null && now() < deadline) {
      await sleep(deps.pollMs ?? POLL_MS);
      done = await readIfPresent(path.join(workDir, "done"), 20);
    }
    if (done === null)
      return {
        ok: false,
        mode: input.mode,
        pages: [],
        changed: false,
        detail: "Visual sidecar did not finish in time",
        durationMs: now() - started,
      };

    const raw = await readIfPresent(path.join(workDir, "result.json"), 500_000);
    if (!raw)
      return {
        ok: false,
        mode: input.mode,
        pages: [],
        changed: false,
        detail: "Visual sidecar wrote no result",
        durationMs: now() - started,
      };

    const parsed = VisualSidecarResult.safeParse(JSON.parse(raw));
    if (!parsed.success)
      return {
        ok: false,
        mode: input.mode,
        pages: [],
        changed: false,
        detail: "Visual sidecar returned an invalid result",
        durationMs: now() - started,
      };

    const pages: VisualPageResult[] = parsed.data.pages.map((p) => ({
      ...p,
      slug: p.slug || visualPageSlug(p.path),
    }));

    return {
      ok: parsed.data.ok,
      mode: input.mode,
      pages,
      changed: parsed.data.changed,
      detail: clean(parsed.data.detail).slice(0, 2000),
      durationMs: now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      mode: input.mode,
      pages: [],
      changed: false,
      detail: clean(err instanceof Error ? err.message : "Visual capture failed"),
      durationMs: now() - started,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Drop leftover request folders after a runner restart (same idea as clearScanWork). */
export async function clearVisualWork(workDir: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  let entries;
  try {
    entries = await readdir(workDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && /^[a-z0-9]{1,64}$/.test(e.name))
      .map((e) => rm(path.join(workDir, e.name), { recursive: true, force: true })),
  );
}
