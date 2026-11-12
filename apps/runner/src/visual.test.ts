import { describe, expect, it } from "vitest";
import { prepareVisualPages } from "./visual";

describe("prepareVisualPages", () => {
  it("allows a public hostname", () => {
    const prepared = prepareVisualPages(
      [{ path: "/", url: "https://example.com/", role: "home" }],
      "example.com",
    );
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.pages[0]?.url).toBe("https://example.com/");
  });

  it("rewrites loopback to the SSH host for test-wp", () => {
    const prepared = prepareVisualPages(
      [{ path: "/", url: "http://127.0.0.1:8080/", role: "home" }],
      "test-wp",
    );
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.pages[0]?.url).toContain("test-wp");
      expect(prepared.pages[0]?.url).not.toContain("127.0.0.1");
    }
  });

  it("refuses a private hostname that isn't the SSH host", () => {
    const prepared = prepareVisualPages(
      [{ path: "/", url: "http://redis:6379/", role: "home" }],
      "test-wp",
    );
    expect(prepared.ok).toBe(false);
  });
});
