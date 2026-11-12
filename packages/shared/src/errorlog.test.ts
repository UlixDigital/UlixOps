// debug.log parsing (A159): levels, grouping, stack traces, short paths, 24-hour counts.
import { describe, expect, it } from "vitest";
import { errorCounts, loggingState, parseErrorLog, shortPath } from "./errorlog";

const NOW = new Date(Date.UTC(2026, 10, 1, 12, 0, 0));
// The real WSI lines from 2026-11-01 (A156 diagnosis), plus newer ones.
const LOG = [
  "[17-Sep-2026 09:22:05 UTC] PHP Fatal error:  Uncaught Error: Call to a member function getServerList() on null in /nas/content/live/wsiwebenhancer/wp-content/drop-ins/wp-cache-memcached/includes/memcached-adapter.php:432",
  "Stack trace:",
  "#0 /nas/content/live/wsiwebenhancer/wp-content/object-cache.php(312): MemcachedAdapter->connect()",
  "#1 {main}",
  "  thrown in /nas/content/live/wsiwebenhancer/wp-content/drop-ins/wp-cache-memcached/includes/memcached-adapter.php on line 432",
  '[01-Nov-2026 10:00:00 UTC] PHP Warning:  Undefined array key "id" in /home/wpe-user/sites/shop/wp-content/plugins/contact-form-7/includes/form.php on line 88',
  '[01-Nov-2026 11:00:00 UTC] PHP Warning:  Undefined array key "id" in /home/wpe-user/sites/shop/wp-content/plugins/contact-form-7/includes/form.php on line 88',
  "[01-Nov-2026 11:30:00 UTC] PHP Deprecated:  Creation of dynamic property is deprecated in /var/www/html/wp-content/themes/astra/inc/core.php on line 7",
  "[01-Nov-2026 11:45:00 UTC] WordPress database error Table 'wp_foo' doesn't exist for query SELECT * FROM wp_foo made by require('wp-blog-header.php')",
  "[01-Nov-2026 11:50:00 UTC] PHP Parse error:  syntax error, unexpected '}' in /var/www/html/wp-content/mu-plugins/custom.php on line 3",
].join("\n");

describe("parseErrorLog", () => {
  const groups = parseErrorLog(LOG, NOW);

  it("groups repeats, and lists recent serious errors first", () => {
    expect(groups.map((g) => g.level)).toEqual([
      "parse",
      "database",
      "warning",
      "deprecated",
      "fatal",
    ]);
    const warning = groups.find((g) => g.level === "warning");
    expect(warning).toMatchObject({
      count: 2,
      count24h: 2,
      message: 'Undefined array key "id"',
      source: "plugin:contact-form-7",
      file: "wp-content/plugins/contact-form-7/includes/form.php",
      line: 88,
      firstAt: "2026-11-01T10:00:00.000Z",
      lastAt: "2026-11-01T11:00:00.000Z",
    });
  });

  it("keeps the stack trace with short paths and names the host's drop-in", () => {
    const fatal = groups.find((g) => g.level === "fatal");
    expect(fatal).toMatchObject({
      source: "host",
      line: 432,
      count24h: 0,
      message: "Uncaught Error: Call to a member function getServerList() on null",
    });
    expect(fatal?.trace[1]).toBe(
      "#0 wp-content/object-cache.php(312): MemcachedAdapter->connect()",
    );
    expect(JSON.stringify(groups)).not.toContain("/nas/content/live");
  });

  it("counts the last 24 hours", () => {
    expect(errorCounts(groups)).toEqual({ fatal: 1, errors: 2, warnings: 2 });
  });

  it("drops a partial first line and applies redaction", () => {
    const g = parseErrorLog(`ror: half a line\n${LOG}`, NOW, {
      startsMidFile: true,
      redact: (s) => s.replaceAll("wp_foo", "[x]"),
    });
    expect(g).toHaveLength(5);
    expect(g.find((x) => x.level === "database")?.message).toContain("[x]");
  });

  it("shortens paths from common hosts", () => {
    expect(shortPath("/var/www/html/index.php")).toBe("index.php");
    expect(shortPath("/home/u/public_html/wp-includes/load.php")).toBe("wp-includes/load.php");
  });
});

describe("loggingState (A160): the way WordPress reads wp-config.php", () => {
  const c = (WP_DEBUG: unknown, WP_DEBUG_LOG: unknown, WP_DEBUG_DISPLAY: unknown) =>
    loggingState({ WP_DEBUG, WP_DEBUG_LOG, WP_DEBUG_DISPLAY } as never);
  it.each([
    [[true, true, false], { state: "on", display: false }],
    [["true", "true", "false"], { state: "on", display: true }],
    [["1", "1", false], { state: "on", display: false }],
    [[true, true, null], { state: "on", display: true }],
    [[false, true, false], { state: "off", display: false }],
    [[null, true, null], { state: "off", display: false }],
    [["0", true, false], { state: "off", display: false }],
    [[true, false, false], { state: "off", display: false }],
    [[true, "/var/log/wp.log", false], { state: "custom", display: false }],
  ])("%j → %j", (values, expected) => {
    expect(c(...(values as [unknown, unknown, unknown]))).toEqual(expected);
  });
});
