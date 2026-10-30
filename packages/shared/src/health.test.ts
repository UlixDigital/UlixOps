import { describe, expect, it } from "vitest";
import {
  bodyLooksCritical,
  buildHealthUrls,
  healthFetchOrigin,
  HealthCheckSettings,
  HealthPath,
  healthUrlRole,
  rewriteHealthFetchUrl,
} from "./health";

describe("HealthPath", () => {
  it.each(["/", "/shop/", "/wp-admin/", "/a-b_c.1/"])("accepts %j", (path) => {
    expect(HealthPath.safeParse(path).success).toBe(true);
  });
  it.each(["shop", "//x", "/../etc", "/a/../../b", ""])("rejects %j", (path) => {
    expect(HealthPath.safeParse(path).success).toBe(false);
  });
});

describe("buildHealthUrls", () => {
  it("always includes home and wp-admin, dedupes extras", () => {
    expect(buildHealthUrls("https://example.test", ["/", "/shop/", "/wp-admin/"])).toEqual([
      "https://example.test/",
      "https://example.test/wp-admin/",
      "https://example.test/shop/",
    ]);
  });
});

describe("rewriteHealthFetchUrl / healthFetchOrigin", () => {
  it("rewrites loopback and host-published :8080/:8082 to the SSH host on port 80", () => {
    expect(rewriteHealthFetchUrl("http://localhost:8080/", "test-wp")).toBe("http://test-wp/");
    expect(rewriteHealthFetchUrl("http://127.0.0.1:8080/wp-admin/", "test-wp")).toBe(
      "http://test-wp/wp-admin/",
    );
    expect(rewriteHealthFetchUrl("http://test-wp:8080/", "test-wp")).toBe("http://test-wp/");
    expect(rewriteHealthFetchUrl("http://localhost:8082/", "test-wp-staging")).toBe(
      "http://test-wp-staging/",
    );
    expect(rewriteHealthFetchUrl("http://test-wp-staging:8082/", "test-wp-staging")).toBe(
      "http://test-wp-staging/",
    );
    expect(healthFetchOrigin("http://localhost:8080", "test-wp")).toBe("http://test-wp");
  });

  it("keeps published ports when sshHost is loopback (host-side e2e)", () => {
    expect(rewriteHealthFetchUrl("http://127.0.0.1:8080/", "127.0.0.1")).toBe(
      "http://127.0.0.1:8080/",
    );
    expect(rewriteHealthFetchUrl("http://localhost:8080/wp-admin/", "127.0.0.1")).toBe(
      "http://127.0.0.1:8080/wp-admin/",
    );
    expect(rewriteHealthFetchUrl("http://127.0.0.1:8082/", "127.0.0.1")).toBe(
      "http://127.0.0.1:8082/",
    );
    expect(healthFetchOrigin("http://localhost:8080", "127.0.0.1")).toBe("http://127.0.0.1:8080");
  });

  it("leaves public site URLs unchanged", () => {
    expect(rewriteHealthFetchUrl("https://shop.example/wp-admin/", "ssh.example")).toBe(
      "https://shop.example/wp-admin/",
    );
    expect(healthFetchOrigin("https://shop.example", "ssh.example")).toBe("https://shop.example");
  });
});

describe("healthUrlRole", () => {
  it("labels home and wp-admin", () => {
    expect(healthUrlRole("https://ex.test/", "https://ex.test")).toBe("home");
    expect(healthUrlRole("https://ex.test/wp-admin/", "https://ex.test")).toBe("wp-admin");
    expect(healthUrlRole("https://ex.test/shop/", "https://ex.test")).toBe("extra");
  });
});

describe("bodyLooksCritical", () => {
  it("detects WordPress critical-error pages", () => {
    expect(bodyLooksCritical("There has been a critical error on this website.")).toBe(true);
    expect(bodyLooksCritical("Fatal error: Allowed memory size of")).toBe(true);
    expect(bodyLooksCritical("<html><body>Hello</body></html>")).toBe(false);
  });
});

describe("HealthCheckSettings", () => {
  it("applies defaults", () => {
    expect(HealthCheckSettings.parse({})).toEqual({
      extraPaths: [],
      thresholdMs: 5_000,
      checkErrorLog: true,
    });
  });
});
