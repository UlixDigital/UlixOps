import { describe, expect, it } from "vitest";
import { slug as Slug, toArgv } from "./commands";

const FIELDS = "--fields=name,title,status,version,update,update_version";
const FIELDS_FAST = "--fields=name,title,status,version";
const SKIP = ["--skip-plugins", "--skip-themes"];

describe("toArgv", () => {
  it.each([
    [{ op: "plugin.list" }, ["wp", "plugin", "list", "--format=json", FIELDS]],
    [{ op: "plugin.list", updates: false }, ["wp", "plugin", "list", "--format=json", FIELDS_FAST]],
    [{ op: "plugin.list", safe: true }, ["wp", "plugin", "list", "--format=json", FIELDS, ...SKIP]],
    [
      { op: "plugin.list", safe: true, updates: false },
      ["wp", "plugin", "list", "--format=json", FIELDS_FAST, ...SKIP],
    ],
    [{ op: "theme.list" }, ["wp", "theme", "list", "--format=json", FIELDS]],
    [{ op: "theme.list", updates: false }, ["wp", "theme", "list", "--format=json", FIELDS_FAST]],
    [{ op: "theme.list", safe: true }, ["wp", "theme", "list", "--format=json", FIELDS, ...SKIP]],
    [{ op: "plugin.deactivate", slug: "ulix-forms" }, ["wp", "plugin", "deactivate", "ulix-forms"]],
    [
      { op: "plugin.deactivate", slug: "ulix-forms", safe: true },
      ["wp", "plugin", "deactivate", "ulix-forms", ...SKIP],
    ],
    [{ op: "plugin.activate", slug: "ulix-forms" }, ["wp", "plugin", "activate", "ulix-forms"]],
    [{ op: "plugin.activate", slug: "js_composer" }, ["wp", "plugin", "activate", "js_composer"]],
    [{ op: "plugin.activate", slug: "LayerSlider" }, ["wp", "plugin", "activate", "LayerSlider"]],
    [{ op: "plugin.update", slug: "akismet" }, ["wp", "plugin", "update", "akismet"]],
    [
      { op: "theme.update", slug: "twentytwentyfive" },
      ["wp", "theme", "update", "twentytwentyfive"],
    ],
    [{ op: "core.version" }, ["wp", "core", "version"]],
    [{ op: "maintenance", on: true }, ["wp", "maintenance-mode", "activate", ...SKIP]],
    [{ op: "maintenance", on: false }, ["wp", "maintenance-mode", "deactivate", ...SKIP]],
    [{ op: "maintenance.status" }, ["wp", "maintenance-mode", "is-active", ...SKIP]],
    [{ op: "cache.flush" }, ["wp", "cache", "flush", ...SKIP]],
    [
      { op: "db.export", file: "/tmp/ulixops-site1-2026.sql" },
      ["wp", "db", "export", "/tmp/ulixops-site1-2026.sql"],
    ],
    [
      { op: "db.import", file: "/tmp/ulixops-abc123.sql" },
      ["wp", "db", "import", "/tmp/ulixops-abc123.sql"],
    ],
  ])("builds argv for %j", (input, expected) => {
    expect(toArgv(input)).toEqual(expected);
  });

  it.each([
    "ulix-forms; rm -rf /",
    "$(id)",
    "`id`",
    "ulix forms",
    "ulix-forms\nwp db drop",
    "../wp-config",
    "..",
    "ulix..forms",
    ".hidden",
    "_private",
    "--all",
    "--uninstall",
    "-",
    "",
    "a".repeat(101),
  ])("rejects unsafe plugin name %j", (slug) => {
    expect(() => toArgv({ op: "plugin.deactivate", slug })).toThrow();
    expect(() => toArgv({ op: "plugin.activate", slug })).toThrow();
  });

  it("keeps registry slugs strict: lower case, digits and - only", () => {
    expect(Slug.safeParse("ulix-forms").success).toBe(true);
    for (const value of ["Ulix-Forms", "ulix_forms", "ulix.forms", "-x"]) {
      expect(Slug.safeParse(value).success).toBe(false);
    }
  });

  it.each([
    "/tmp/ulixops-x.sql; rm -rf /",
    "/tmp/../etc/passwd",
    "/tmp/ulixops-../../wp-config.sql",
    "/var/www/html/ulixops-x.sql",
    "/tmp/ulixops-x.sql.gz",
    "/tmp/ulixops-.sql",
  ])("rejects unsafe export path %j", (file) => {
    expect(() => toArgv({ op: "db.export", file })).toThrow();
  });

  it("rejects operations that are not on the allowlist", () => {
    expect(() => toArgv({ op: "db.drop" })).toThrow();
    expect(() => toArgv({ op: "eval", code: "phpinfo();" })).toThrow();
    expect(() => toArgv("wp plugin list")).toThrow();
    expect(() => toArgv(null)).toThrow();
  });

  it("rejects wrongly typed arguments", () => {
    expect(() => toArgv({ op: "maintenance", on: "true" })).toThrow();
    expect(() => toArgv({ op: "plugin.list", safe: "--skip-packages" })).toThrow();
    expect(() => toArgv({ op: "plugin.activate", slug: ["ulix-forms"] })).toThrow();
  });

  it("points WP-CLI at a validated install path", () => {
    expect(toArgv({ op: "core.version" }, { wpPath: "/var/www/html" })).toEqual([
      "wp",
      "--path=/var/www/html",
      "core",
      "version",
    ]);
    expect(toArgv({ op: "cli.info" })).toEqual(["wp", "cli", "info", "--format=json"]);
    for (const wpPath of [
      "relative/path",
      "/var/www/../etc",
      "/var/www/html; id",
      "/var/www html",
      "/$(id)",
      "",
    ]) {
      expect(() => toArgv({ op: "core.version" }, { wpPath })).toThrow();
    }
  });

  it("ignores unknown keys instead of passing them through", () => {
    expect(toArgv({ op: "core.version", extra: "; rm -rf /" })).toEqual(["wp", "core", "version"]);
  });
});
