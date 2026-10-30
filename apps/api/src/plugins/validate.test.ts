import { MAX_PLUGIN_ZIP_BYTES } from "@ulixops/shared";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { finderZip, makeZip, pluginPhp, pluginZip, type TestEntry } from "../../test/zip";
import {
  checkPluginZip,
  headerField,
  isMacMetadata,
  MAC_METADATA_NOTE,
  ZIP_LIMITS,
} from "./validate";
import { readEntries } from "./zip";

const main = (data = pluginPhp()): TestEntry => ({ name: "ulix-forms/ulix-forms.php", data });
const failedAt = (buf: Buffer, filename = "ulix-forms.zip") => {
  const result = checkPluginZip(buf, filename);
  expect(result.ok).toBe(false);
  const last = result.checks[result.checks.length - 1];
  expect(last?.ok).toBe(false);
  return { check: last?.name, detail: last?.detail ?? "", result };
};

describe("checkPluginZip", () => {
  it("accepts a normal plugin ZIP and reads its header", () => {
    const result = checkPluginZip(pluginZip(), "ulix-forms-1.2.0.zip");
    expect(result).toMatchObject({
      ok: true,
      slug: "ulix-forms",
      name: "Ulix Forms",
      version: "1.2.0",
      requiresWp: "6.4",
      requiresPhp: "8.1",
      fileCount: 2,
      warnings: [],
    });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.checks.map((c) => [c.name, c.ok])).toEqual([
      ["file", true],
      ["archive", true],
      ["paths", true],
      ["layout", true],
      ["plugin", true],
      ["contents", true],
    ]);
  });

  describe("file", () => {
    it.each([
      ["empty", Buffer.alloc(0), "x.zip", /empty/],
      ["too large", Buffer.alloc(MAX_PLUGIN_ZIP_BYTES + 1), "x.zip", /larger than 10 MB/],
      ["not .zip", pluginZip(), "plugin.tar.gz", /must end in \.zip/],
      ["not a ZIP inside", Buffer.from("<?php echo 1;"), "evil.zip", /isn't a ZIP/],
      ["random bytes", randomBytes(2048), "noise.zip", /isn't a ZIP/],
    ])("refuses %s", (_label, buf, filename, message) => {
      const { check, detail } = failedAt(buf, filename);
      expect(check).toBe("file");
      expect(detail).toMatch(message);
    });
  });

  describe("archive", () => {
    it.each([
      ["an encrypted entry", makeZip([{ ...main(), flags: 0x0001 }]), /encrypted/],
      ["a ZIP64 archive", makeZip([main()], { zip64Locator: true }), /ZIP64/],
      ["trailing data", makeZip([main()], { trailing: Buffer.from("junk") }), /Not a ZIP/],
      [
        "overlapping entries",
        makeZip([main(), { name: "ulix-forms/other.php", data: "x" }], { overlap: true }),
        /overlap/,
      ],
      [
        "a local header that names another file",
        makeZip([{ ...main(), localName: "ulix-forms/evil.php" }]),
        /doesn't match/,
      ],
      [
        "an entry that claims to unpack to 40 MB",
        makeZip([{ ...main(), size: 40 * 1024 * 1024 }]),
        /too large when unpacked/,
      ],
    ])("refuses %s", (_label, buf, message) => {
      const { check, detail } = failedAt(buf);
      expect(check).toBe("archive");
      expect(detail).toMatch(message);
    });

    it("refuses an archive that unpacks to more than the total limit", () => {
      const big = Buffer.alloc(20 * 1024 * 1024, 0x61);
      const buf = makeZip([
        main(),
        ...[1, 2, 3, 4].map((n) => ({ name: `ulix-forms/blob${n}.txt`, data: big })),
      ]);
      expect(buf.length).toBeLessThan(MAX_PLUGIN_ZIP_BYTES);
      const { check, detail } = failedAt(buf);
      expect(check).toBe("archive");
      expect(detail).toMatch(/unpacks to more than/);
    });
  });

  describe("paths", () => {
    it.each([
      ["../evil.php", /'\.\.'/],
      ["ulix-forms/../../wp-config.php", /'\.\.'/],
      ["/etc/passwd", /absolute path/],
      ["ulix-forms\\..\\evil.php", /characters/],
      ["C:/evil.php", /characters/],
      ["ulix-forms//double.php", /empty/],
      ["ulix-forms/./x.php", /'\.'/],
      ["ulix-forms/bad\u0000name.php", /characters/],
    ])("refuses %j", (name, message) => {
      const { check, detail } = failedAt(makeZip([main(), { name, data: "x" }]));
      expect(check).toBe("paths");
      expect(detail).toMatch(message);
    });

    it("refuses symbolic links and special files", () => {
      const link = makeZip([
        main(),
        { name: "ulix-forms/up", data: "../../..", unixMode: 0o120777 },
      ]);
      expect(failedAt(link).detail).toMatch(/symbolic link/);
      const fifo = makeZip([main(), { name: "ulix-forms/pipe", data: "", unixMode: 0o010644 }]);
      expect(failedAt(fifo).detail).toMatch(/regular file/);
    });

    it("refuses duplicate names, ignoring case", () => {
      const buf = makeZip([
        main(),
        { name: "ulix-forms/A.php", data: "1" },
        { name: "ulix-forms/a.php", data: "2" },
      ]);
      expect(failedAt(buf).detail).toMatch(/more than once/);
    });

    it("accepts regular Unix files and folders", () => {
      const buf = makeZip([
        { name: "ulix-forms/", unixMode: 0o040755 },
        { ...main(), unixMode: 0o100644 },
      ]);
      expect(checkPluginZip(buf, "x.zip").ok).toBe(true);
    });
  });

  describe("layout", () => {
    it.each([
      [
        "a file at the top level",
        makeZip([main(), { name: "readme.txt", data: "x" }]),
        /top level/,
      ],
      [
        "two folders",
        makeZip([main(), { name: "other/other.php", data: pluginPhp("Other") }]),
        /2 top-level folders/,
      ],
      [
        "a plugin folder that is only macOS metadata",
        makeZip([{ name: "__MACOSX/ulix-forms/._ulix-forms.php", data: pluginPhp() }]),
        /0 top-level folders/,
      ],
      [
        "a folder that isn't a slug",
        makeZip([{ name: "Ulix_Forms/Ulix_Forms.php", data: pluginPhp() }]),
        /isn't a valid plugin slug/,
      ],
    ])("refuses %s", (_label, buf, message) => {
      const { check, detail } = failedAt(buf);
      expect(check).toBe("layout");
      expect(detail).toMatch(message);
    });
  });

  describe("plugin header", () => {
    it.each([
      ["no header", "<?php echo 1;", /No PHP file/],
      ["no version", "<?php\n/* Plugin Name: Ulix Forms */", /no "Version:"/],
      ["a version that could be a flag", pluginPhp("Ulix Forms", "--force"), /isn't valid/],
      ["a version with spaces", pluginPhp("Ulix Forms", "1.0 beta"), /isn't valid/],
    ])("refuses %s", (_label, php, message) => {
      const { check, detail } = failedAt(makeZip([main(php)]));
      expect(check).toBe("plugin");
      expect(detail).toMatch(message);
    });

    it("refuses two plugins in one folder", () => {
      const buf = makeZip([main(), { name: "ulix-forms/second.php", data: pluginPhp("Second") }]);
      expect(failedAt(buf).detail).toMatch(/More than one/);
    });

    it("only reads headers from PHP files directly in the folder", () => {
      const buf = makeZip([
        { name: "ulix-forms/includes/x.php", data: pluginPhp() },
        { name: "ulix-forms/readme.txt", data: "Plugin Name: no" },
      ]);
      expect(failedAt(buf).check).toBe("plugin");
    });

    it("notes an unusual main file name", () => {
      const buf = makeZip([{ name: "ulix-forms/plugin.php", data: pluginPhp() }]);
      const result = checkPluginZip(buf, "x.zip");
      expect(result.ok).toBe(true);
      expect(result.warnings[0]).toMatch(/main file is ulix-forms\/plugin\.php/);
    });
  });

  describe("contents scan", () => {
    it.each([
      "ulix-forms/.env",
      "ulix-forms/config/.env.production",
      "ulix-forms/wp-config.php",
      "ulix-forms/.user.ini",
      "ulix-forms/certs/server.pem",
      "ulix-forms/deploy/id_ed25519",
      "ulix-forms/vendor/tool.phar",
      "ulix-forms/bin/helper.so",
      "ulix-forms/.git/config",
      "ulix-forms/.ssh/authorized_keys",
    ])("refuses %s", (name) => {
      const { check } = failedAt(makeZip([main(), { name, data: "x" }]));
      expect(check).toBe("contents");
    });

    it("refuses a private key hidden in any file", () => {
      const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
      const { check, detail } = failedAt(
        makeZip([main(), { name: "ulix-forms/assets/notes.txt", data: key }]),
      );
      expect(check).toBe("contents");
      expect(detail).toMatch(/private key/);
    });

    it("refuses an entry whose content doesn't match its CRC or size", () => {
      expect(
        failedAt(makeZip([main(), { name: "ulix-forms/a.php", data: "abc", crc: 1 }])).detail,
      ).toMatch(/CRC/);
      const lying = makeZip([
        main(),
        { name: "ulix-forms/b.php", data: "a".repeat(5000), size: 10 },
      ]);
      expect(failedAt(lying).detail).toMatch(/larger than it claims|isn't the size/);
    });

    it("allows but notes scripts, archives, .htaccess and obfuscated PHP", () => {
      const result = checkPluginZip(
        makeZip([
          main(),
          { name: "ulix-forms/.env.example", data: "KEY=" },
          { name: "ulix-forms/bin/install.sh", data: "#!/bin/sh" },
          { name: "ulix-forms/assets/.htaccess", data: "Deny from all" },
          { name: "ulix-forms/lib/x.php", data: "<?php eval(base64_decode('ZWNobyAxOw=='));" },
        ]),
        "x.zip",
      );
      expect(result.ok).toBe(true);
      expect(result.warnings.join("\n")).toMatch(/install\.sh/);
      expect(result.warnings.join("\n")).toMatch(/\.htaccess/);
      expect(result.warnings.join("\n")).toMatch(/hide malware/);
    });
  });
});

describe("macOS metadata (Finder → Compress)", () => {
  const names = (zip: Buffer) => readEntries(zip, ZIP_LIMITS).map((e) => e.name);

  it("accepts a Finder ZIP, ignores the metadata and keeps a copy without it", () => {
    const upload = finderZip();
    const result = checkPluginZip(upload, "ulix-forms.zip");
    expect(result).toMatchObject({
      ok: true,
      slug: "ulix-forms",
      version: "1.2.0",
      fileCount: 2,
      warnings: [],
    });
    expect(result.notes[0]).toBe(MAC_METADATA_NOTE);
    expect(result.notes[1]).toMatch(/7 macOS entries were left out/);
    expect(result.uploadedSha256).toBe(createHash("sha256").update(upload).digest("hex"));
    expect(result.sha256).toBe(createHash("sha256").update(result.zip).digest("hex"));
    expect(result.sha256).not.toBe(result.uploadedSha256);
    expect(result.sizeBytes).toBe(result.zip.length);
    expect(names(result.zip)).toEqual([
      "ulix-forms/",
      "ulix-forms/ulix-forms.php",
      "ulix-forms/includes/",
      "ulix-forms/includes/form.php",
    ]);
    // The kept copy passes on its own, unchanged: that is what gets saved and checked again.
    const again = checkPluginZip(result.zip, "ulix-forms.zip");
    expect(again).toMatchObject({
      ok: true,
      notes: [],
      uploadedSha256: null,
      sha256: result.sha256,
    });
  });

  it("leaves ZIPs without metadata untouched", () => {
    const upload = pluginZip();
    const result = checkPluginZip(upload, "x.zip");
    expect(result).toMatchObject({ ok: true, notes: [], uploadedSha256: null });
    expect(result.zip).toBe(upload);
  });

  it("ignores ._ files anywhere: not a second plugin, not scanned, not kept", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    const result = checkPluginZip(
      makeZip([
        main(),
        { name: "ulix-forms/._ulix-forms.php", data: pluginPhp("Fork") },
        { name: "ulix-forms/assets/._logo.png", data: key },
      ]),
      "x.zip",
    );
    expect(result.ok).toBe(true);
    expect(result.notes[0]).toBe(MAC_METADATA_NOTE);
    expect(names(result.zip)).toEqual(["ulix-forms/ulix-forms.php"]);
    expect(result.zip.includes(Buffer.from("PRIVATE KEY"))).toBe(false);
  });

  it.each([
    [
      "a symbolic link",
      { name: "__MACOSX/ulix-forms/._up", data: "../../..", unixMode: 0o120777 },
      "paths",
      /symbolic link/,
    ],
    ["a '..' path", { name: "__MACOSX/../evil.php", data: "<?php" }, "paths", /'\.\.'/],
    [
      "a '..' path deeper in",
      { name: "__MACOSX/ulix-forms/../../../wp-config.php", data: "x" },
      "paths",
      /'\.\.'/,
    ],
    ["a '..' in a ._ name's folder", { name: "ulix-forms/../._x", data: "x" }, "paths", /'\.\.'/],
    ["an absolute path", { name: "/__MACOSX/._x", data: "x" }, "paths", /absolute/],
    ["a backslash path", { name: "__MACOSX\\..\\evil.php", data: "x" }, "paths", /characters/],
    [
      "a special file",
      { name: "__MACOSX/ulix-forms/._pipe", data: "", unixMode: 0o010644 },
      "paths",
      /regular file/,
    ],
    [
      "a zip bomb",
      { name: "__MACOSX/ulix-forms/._huge", data: "x", size: 40 * 1024 * 1024 },
      "archive",
      /too large when unpacked/,
    ],
    ["a duplicate", { name: "__MACOSX/ulix-forms/", data: "" }, "paths", /more than once/],
  ] as [string, TestEntry, string, RegExp][])(
    "still refuses %s inside the metadata",
    (_label, entry, check, message) => {
      const { check: failed, detail } = failedAt(finderZip([entry]));
      expect(failed).toBe(check);
      expect(detail).toMatch(message);
    },
  );

  it("stays strict about everything that isn't Finder metadata", () => {
    // __MACOSX only counts at the top level; inside the plugin it is still refused.
    expect(failedAt(makeZip([main(), { name: "ulix-forms/__MACOSX/x", data: "x" }])).check).toBe(
      "contents",
    );
    // A real second folder is still a second plugin folder.
    expect(
      failedAt(finderZip([{ name: "other/other.php", data: pluginPhp("Other") }])).detail,
    ).toMatch(/2 top-level folders/);
    expect(isMacMetadata("ulix-forms/DS_Store")).toBe(false);
    expect(isMacMetadata("ulix-forms/x._y")).toBe(false);
    expect(isMacMetadata("ulix-forms/sub/.DS_Store")).toBe(true);
    expect(isMacMetadata("__MACOSX/")).toBe(true);
  });
});

describe("headerField", () => {
  it("reads WordPress-style headers", () => {
    expect(headerField(" * Plugin Name: Ulix Forms */", "Plugin Name")).toBe("Ulix Forms");
    expect(headerField("# version: 2.0 ?>", "Version")).toBe("2.0");
    expect(headerField("Version:", "Version")).toBeNull();
    expect(headerField(`${"x".repeat(9000)}\nVersion: 1`, "Version")).toBeNull();
    // Like WordPress: "<?php" may start the line, and "\r" ends one.
    expect(headerField("<?php /* Plugin Name: One Line */", "Plugin Name")).toBe("One Line");
    expect(headerField("<?php\r/**\r * Version: 3.1\r */", "Version")).toBe("3.1");
    expect(headerField("echo 1; // Version: 9", "Version")).toBeNull();
  });
});
