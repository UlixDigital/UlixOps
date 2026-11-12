import { describe, expect, it } from "vitest";
import {
  buildVisualPages,
  visualDiffPercent,
  visualPageSlug,
  VisualCheckSettings,
  VisualCaptureResult,
  VisualSidecarRequest,
} from "./visual";

describe("visualPageSlug", () => {
  it("maps the homepage to home", () => {
    expect(visualPageSlug("/")).toBe("home");
    expect(visualPageSlug("")).toBe("home");
  });

  it("strips slashes and sanitises", () => {
    expect(visualPageSlug("/shop/")).toBe("shop");
    expect(visualPageSlug("/about us/team")).toBe("about-us-team");
  });
});

describe("visualDiffPercent", () => {
  it("returns 0 when nothing changed", () => {
    expect(visualDiffPercent(0, 100, 100)).toBe(0);
  });

  it("rounds to two decimals", () => {
    expect(visualDiffPercent(1, 100, 100)).toBe(0.01);
    expect(visualDiffPercent(150, 100, 100)).toBe(1.5);
  });

  it("caps at 100", () => {
    expect(visualDiffPercent(20_000, 100, 100)).toBe(100);
  });
});

describe("buildVisualPages", () => {
  it("uses the homepage and extra paths, never wp-admin", () => {
    const pages = buildVisualPages("https://example.com", "example.com", {
      extraPaths: ["/shop/", "/wp-admin/"],
      thresholdMs: 5000,
      checkErrorLog: true,
      checkWpAdmin: true,
    });
    expect(pages.map((p) => p.path)).toEqual(["/", "/shop/"]);
    expect(pages[0]?.role).toBe("home");
    expect(pages[1]?.role).toBe("extra");
  });

  it("caps at MAX_VISUAL_PAGES", () => {
    const extras = Array.from({ length: 20 }, (_, i) => `/p${i}/`);
    const pages = buildVisualPages("https://example.com", "example.com", {
      extraPaths: extras,
      thresholdMs: 5000,
      checkErrorLog: false,
      checkWpAdmin: false,
    });
    expect(pages.length).toBe(10);
  });
});

describe("schemas", () => {
  it("parses default settings", () => {
    const s = VisualCheckSettings.parse({});
    expect(s.enabled).toBe(true);
    expect(s.maxDiffPercent).toBe(1);
    expect(s.viewportWidth).toBe(1280);
  });

  it("parses a capture result", () => {
    const r = VisualCaptureResult.parse({
      ok: true,
      mode: "after",
      pages: [
        {
          path: "/",
          slug: "home",
          role: "home",
          url: "https://example.com/",
          ok: true,
          status: 200,
          durationMs: 120,
          detail: "ok",
          diffPercent: 0.5,
          changed: false,
          beforeFile: "home-before.png",
          afterFile: "home-after.png",
          diffFile: "home-diff.png",
        },
      ],
      changed: false,
      detail: "1 page clean",
      durationMs: 400,
    });
    expect(r.pages).toHaveLength(1);
  });

  it("parses a sidecar request", () => {
    const req = VisualSidecarRequest.parse({
      id: "abc123",
      mode: "before",
      pages: [{ path: "/", url: "https://example.com/", role: "home" }],
      viewportWidth: 1280,
      viewportHeight: 720,
      maxDiffPercent: 1,
      pixelThreshold: 0.1,
      storeDir: "/data/visual/abc123",
    });
    expect(req.mode).toBe("before");
  });
});
