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
    [{ op: "plugin.delete", slug: "hello" }, ["wp", "plugin", "delete", "hello"]],
    [
      { op: "theme.delete", slug: "twentytwentythree" },
      ["wp", "theme", "delete", "twentytwentythree"],
    ],
    [
      { op: "core.check-update" },
      ["wp", "core", "check-update", "--format=json", "--fields=version,update_type", ...SKIP],
    ],
    [{ op: "core.update", version: "6.8.3" }, ["wp", "core", "update", "--version=6.8.3"]],
    [
      { op: "core.update", version: "6.7", force: true },
      ["wp", "core", "update", "--version=6.7", "--force"],
    ],
    [{ op: "core.update-db" }, ["wp", "core", "update-db"]],
    [{ op: "core.verify-checksums" }, ["wp", "core", "verify-checksums"]],
    [
      { op: "backup.archive", wpPath: "/sites/shop", dbFile: "/tmp/ulixops-abc.sql" },
      [
        "tar",
        "-czf",
        "-",
        "--exclude=./wp-content/cache",
        "--exclude=./wp-content/upgrade",
        "--exclude=./wp-content/updraft",
        "--exclude=./wp-content/ai1wm-backups",
        "--exclude=./wp-content/backups-dup-pro",
        "--exclude=./wp-content/backup-db",
        "--exclude=./wp-content/uploads/backwpup*",
        "-C",
        "/tmp",
        "ulixops-abc.sql",
        "-C",
        "/sites/shop",
        ".",
      ],
    ],
    [
      { op: "restore.database", dbFile: "/tmp/ulixops-abc.sql" },
      ["tar", "-xzf", "-", "--occurrence=1", "--no-same-owner", "-C", "/tmp", "ulixops-abc.sql"],
    ],
    [
      {
        op: "restore.files",
        wpPath: "/sites/shop",
        dbFile: "/tmp/ulixops-abc.sql",
        wpContent: false,
      },
      [
        "tar",
        "-xzf",
        "-",
        "--no-same-owner",
        "--no-overwrite-dir",
        "--exclude=ulixops-abc.sql",
        "--exclude=./wp-config.php",
        "-C",
        "/sites/shop",
      ],
    ],
    [
      {
        op: "restore.files",
        wpPath: "/sites/shop",
        dbFile: "/tmp/ulixops-abc.sql",
        wpContent: true,
      },
      [
        "tar",
        "-xzf",
        "-",
        "--no-same-owner",
        "--no-overwrite-dir",
        "--exclude=ulixops-abc.sql",
        "--exclude=./wp-config.php",
        "-C",
        "/sites/shop",
        "./wp-content",
      ],
    ],
    [
      { op: "plugin.verify-checksums" },
      ["wp", "plugin", "verify-checksums", "--all", "--format=json", ...SKIP],
    ],
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
    [{ op: "db.reset" }, ["wp", "db", "reset", "--yes", ...SKIP]],
    [
      { op: "restore.clear-content", wpPath: "/sites/shop" },
      [
        "rm",
        "-rf",
        "--",
        "/sites/shop/wp-content/plugins",
        "/sites/shop/wp-content/themes",
        "/sites/shop/wp-content/uploads",
      ],
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
    expect(() => toArgv({ op: "plugin.delete", slug })).toThrow();
    expect(() => toArgv({ op: "theme.delete", slug })).toThrow();
  });

  it("never adds --path to a non-WP-CLI command, and refuses odd archive paths", () => {
    const argv = toArgv(
      { op: "backup.archive", wpPath: "/sites/shop", dbFile: "/tmp/ulixops-a.sql" },
      { wpPath: "/sites/other" },
    );
    expect(argv[0]).toBe("tar");
    expect(argv).not.toContain("--path=/sites/other");
    for (const bad of [
      { wpPath: "/sites/../etc", dbFile: "/tmp/ulixops-a.sql" },
      { wpPath: "/sites/shop", dbFile: "/etc/passwd" },
      { wpPath: "/sites/shop", dbFile: "/tmp/ulixops-a.sql; rm -rf /" },
      { wpPath: "/sites/shop --to-command=id", dbFile: "/tmp/ulixops-a.sql" },
    ])
      expect(() => toArgv({ op: "backup.archive", ...bad })).toThrow();
  });

  it("builds the cross-environment restore commands (A157)", () => {
    expect(toArgv({ op: "db.prefix" }, { wpPath: "/sites/shop" })).toEqual([
      "wp",
      "--path=/sites/shop",
      "db",
      "prefix",
      "--skip-plugins",
      "--skip-themes",
    ]);
    expect(toArgv({ op: "restore.dump-prefix", dbFile: "/tmp/ulixops-a.sql" })).toEqual([
      "grep",
      "-m",
      "1",
      "-oE",
      "CREATE TABLE( IF NOT EXISTS)? [`']?[A-Za-z0-9_]+options[`']?",
      "/tmp/ulixops-a.sql",
    ]);
    const sr = (escaped: boolean) =>
      toArgv({
        op: "db.search-replace",
        from: "shop.com/axiom",
        to: "shopstg.wpenginepowered.com",
        escaped,
      });
    expect(sr(false).slice(1, 4)).toEqual([
      "search-replace",
      "//shop.com/axiom",
      "//shopstg.wpenginepowered.com",
    ]);
    expect(sr(true).slice(2, 4)).toEqual([
      "\\/\\/shop.com/axiom",
      "\\/\\/shopstg.wpenginepowered.com",
    ]);
    expect(sr(false)).toContain("--skip-columns=guid");
    for (const bad of [
      "shop.com; id",
      "https://shop.com",
      "Shop.com",
      "shop",
      "shop.com/../x",
      "shop.com/a b",
      "-shop.com",
    ])
      expect(() =>
        toArgv({ op: "db.search-replace", from: bad, to: "x.example.com", escaped: false }),
      ).toThrow();
  });

  it("refuses odd restore paths (A152)", () => {
    for (const bad of [
      { wpPath: "/sites/../etc", dbFile: "/tmp/ulixops-a.sql" },
      { wpPath: "/sites/shop", dbFile: "/etc/passwd" },
      { wpPath: "/sites/shop", dbFile: "/tmp/ulixops-a.sql --to-command=id" },
      { wpPath: "/sites/shop --to-command=id", dbFile: "/tmp/ulixops-a.sql" },
      { wpPath: "relative/path", dbFile: "/tmp/ulixops-a.sql" },
    ])
      expect(() => toArgv({ op: "restore.files", wpContent: false, ...bad })).toThrow();
    expect(() => toArgv({ op: "restore.database", dbFile: "/tmp/../etc/x.sql" })).toThrow();
    expect(() => toArgv({ op: "restore.database", dbFile: "/etc/passwd" })).toThrow();
    expect(() =>
      toArgv({ op: "restore.files", wpPath: "/sites/shop", dbFile: "/tmp/ulixops-a.sql" }),
    ).toThrow();
  });

  it.each(["latest", "nightly", "6.8.3; id", "6", "--force", "6.8.3.1", "6.8-beta1", ""])(
    "rejects core version %j",
    (version) => {
      expect(() => toArgv({ op: "core.update", version })).toThrow();
    },
  );

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
