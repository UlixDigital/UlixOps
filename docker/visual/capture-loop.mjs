#!/usr/bin/env node
// Playwright sidecar for UlixOps visual checks (A163). Polls /work/<id>/request.json,
// screenshots each page, diffs against *-before.png when mode is after/once, writes
// result.json + done. No network access to the hub — only the pages in the request.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const WORK = process.env.VISUAL_WORK_DIR || "/work";
const POLL_MS = 2_000;
const NAV_TIMEOUT_MS = 30_000;
const MAX_PAGES = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugOf(pagePath) {
  const trimmed = pagePath.trim().replace(/\/+/g, "/");
  if (trimmed === "/" || trimmed === "") return "home";
  return (
    trimmed
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page"
  );
}

function diffPercent(changed, width, height) {
  const total = Math.max(1, width * height);
  return Math.min(100, Math.round((10000 * Math.max(0, changed)) / total) / 100);
}

async function readPng(file) {
  const buf = await readFile(file);
  return PNG.sync.read(buf);
}

async function writePng(file, png) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, PNG.sync.write(png), { mode: 0o640 });
  await rename(tmp, file);
}

async function diffImages(beforeFile, afterFile, diffFile, threshold) {
  const before = await readPng(beforeFile);
  const after = await readPng(afterFile);
  if (before.width !== after.width || before.height !== after.height) {
    // Resize is out of scope: treat dimension mismatch as fully changed.
    const w = Math.max(before.width, after.width);
    const h = Math.max(before.height, after.height);
    const diff = new PNG({ width: w, height: h });
    await writePng(diffFile, diff);
    return { percent: 100, changedPixels: w * h };
  }
  const diff = new PNG({ width: before.width, height: before.height });
  const changedPixels = pixelmatch(
    before.data,
    after.data,
    diff.data,
    before.width,
    before.height,
    { threshold, includeAA: true },
  );
  await writePng(diffFile, diff);
  return {
    percent: diffPercent(changedPixels, before.width, before.height),
    changedPixels,
  };
}

async function capturePage(browser, pageReq, opts) {
  const started = Date.now();
  const slug = slugOf(pageReq.path);
  const context = await browser.newContext({
    viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
    userAgent: "UlixOps-VisualCheck/1",
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(pageReq.url, {
      waitUntil: "networkidle",
      timeout: NAV_TIMEOUT_MS,
    });
    const status = response?.status() ?? null;
    // Settle dynamic layouts briefly without waiting forever.
    await sleep(500);
    const suffix = opts.mode === "before" ? "before" : opts.mode === "after" ? "after" : "after";
    const fileName = `${slug}-${suffix}.png`;
    const filePath = path.join(opts.storeDir, fileName);
    await page.screenshot({ path: filePath, fullPage: false, type: "png" });
    const result = {
      path: pageReq.path,
      slug,
      role: pageReq.role,
      url: pageReq.url,
      ok: status !== null && status < 500,
      status,
      durationMs: Date.now() - started,
      detail: status === null ? "No HTTP response" : status >= 500 ? `HTTP ${status}` : "ok",
      diffPercent: null,
      changed: false,
      beforeFile: null,
      afterFile: null,
      diffFile: null,
    };
    if (opts.mode === "before") {
      result.beforeFile = fileName;
    } else {
      result.afterFile = fileName;
      const beforeName = `${slug}-before.png`;
      const beforePath = path.join(opts.storeDir, beforeName);
      if (existsSync(beforePath) && (opts.mode === "after" || opts.mode === "once")) {
        const diffName = `${slug}-diff.png`;
        const diffPath = path.join(opts.storeDir, diffName);
        try {
          const d = await diffImages(beforePath, filePath, diffPath, opts.pixelThreshold);
          result.beforeFile = beforeName;
          result.diffFile = diffName;
          result.diffPercent = d.percent;
          result.changed = d.percent > opts.maxDiffPercent;
          if (result.changed)
            result.detail = `${d.percent}% of pixels changed (limit ${opts.maxDiffPercent}%)`;
        } catch (err) {
          result.detail = `Diff failed: ${err instanceof Error ? err.message : "unknown"}`.slice(
            0,
            500,
          );
          result.ok = false;
        }
      } else if (opts.mode === "after") {
        result.detail = "No before screenshot to compare";
        result.ok = false;
      }
    }
    return result;
  } catch (err) {
    return {
      path: pageReq.path,
      slug,
      role: pageReq.role,
      url: pageReq.url,
      ok: false,
      status: null,
      durationMs: Date.now() - started,
      detail: (err instanceof Error ? err.message : "Screenshot failed").slice(0, 500),
      diffPercent: null,
      changed: false,
      beforeFile: null,
      afterFile: null,
      diffFile: null,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function handleRequest(dir, req) {
  const started = Date.now();
  await mkdir(req.storeDir, { recursive: true, mode: 0o750 });
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const pages = [];
    for (const pageReq of req.pages.slice(0, MAX_PAGES)) {
      if (existsSync(path.join(dir, "cancel"))) {
        return {
          ok: false,
          pages,
          changed: false,
          detail: "Stopped on request.",
          durationMs: Date.now() - started,
        };
      }
      pages.push(
        await capturePage(browser, pageReq, {
          mode: req.mode,
          storeDir: req.storeDir,
          viewportWidth: req.viewportWidth,
          viewportHeight: req.viewportHeight,
          maxDiffPercent: req.maxDiffPercent,
          pixelThreshold: req.pixelThreshold,
        }),
      );
    }
    const anyFail = pages.some((p) => !p.ok);
    const changed = pages.some((p) => p.changed);
    const changedCount = pages.filter((p) => p.changed).length;
    let detail;
    if (anyFail) detail = pages.find((p) => !p.ok)?.detail ?? "Capture failed";
    else if (changed) detail = `${changedCount} of ${pages.length} page(s) changed`;
    else detail = `${pages.length} page(s) clean`;
    return {
      ok: !anyFail,
      pages,
      changed,
      detail: detail.slice(0, 2000),
      durationMs: Date.now() - started,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function processOne(id) {
  const dir = path.join(WORK, id);
  const reqPath = path.join(dir, "request.json");
  if (!existsSync(reqPath) || existsSync(path.join(dir, "done"))) return;
  let req;
  try {
    req = JSON.parse(await readFile(reqPath, "utf8"));
  } catch {
    await writeFile(
      path.join(dir, "result.json"),
      JSON.stringify({
        ok: false,
        pages: [],
        changed: false,
        detail: "Invalid request.json",
        durationMs: 0,
      }),
    );
    await writeFile(path.join(dir, "done"), "1");
    return;
  }
  // Claim the job so a second loop iteration doesn't start it again.
  try {
    await rename(reqPath, path.join(dir, "request.running.json"));
  } catch {
    return;
  }
  const result = await handleRequest(dir, req);
  const tmp = path.join(dir, "result.json.tmp");
  await writeFile(tmp, JSON.stringify(result), { mode: 0o640 });
  await rename(tmp, path.join(dir, "result.json"));
  await writeFile(path.join(dir, "done"), "1", { mode: 0o640 });
}

async function loop() {
  console.log(`ulixops-visual: watching ${WORK}`);
  for (;;) {
    try {
      const entries = await readdir(WORK, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (!/^[a-z0-9]{1,64}$/.test(ent.name)) continue;
        await processOne(ent.name);
      }
    } catch (err) {
      console.error("loop error:", err instanceof Error ? err.message : err);
    }
    await sleep(POLL_MS);
  }
}

loop().catch((err) => {
  console.error(err);
  process.exit(1);
});
