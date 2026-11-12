import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeRelativePath, scanTarArgv, TarToDisk } from "./scan-copy";
import { packTar } from "./tar";

const dirs: string[] = [];
const tempRoot = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ulixops-scancopy-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One raw tar entry with any type flag and name (to build hostile archives). */
function rawEntry(name: string, type: string, data = Buffer.alloc(0), linkName = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write(type, 156);
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.fill(" ", 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}

async function feed(tar: TarToDisk, data: Buffer, size: number) {
  for (let i = 0; i < data.length; i += size) {
    if ((await tar.push(data.subarray(i, i + size))) === "stop") return;
  }
}

describe("safeRelativePath", () => {
  it.each([
    ["./wp-config.php", "wp-config.php"],
    ["wp-content//plugins/./a.php", "wp-content/plugins/a.php"],
  ])("keeps %j as %j", (raw, expected) => {
    expect(safeRelativePath(raw)).toBe(expected);
  });
  it.each(["../etc/passwd", "a/../../b", "/etc/passwd", "", ".", "./"])("refuses %j", (raw) => {
    expect(safeRelativePath(raw)).toBeNull();
  });
});

describe("TarToDisk", () => {
  it.each([1, 7, 511, 513, 65_536])("writes regular files with %i-byte chunks", async (size) => {
    const root = tempRoot();
    const tar = new TarToDisk(root);
    await feed(
      tar,
      packTar([
        { path: "./index.php", data: Buffer.from("<?php echo 1;") },
        { path: "wp-content/plugins/x/x.php", data: Buffer.from("x".repeat(1500)) },
        { path: `wp-content/${"d".repeat(120)}/long.php`, data: Buffer.from("long") },
      ]),
      size,
    );
    expect(tar.files).toBe(3);
    expect(readFileSync(path.join(root, "index.php"), "utf8")).toBe("<?php echo 1;");
    expect(readFileSync(path.join(root, "wp-content/plugins/x/x.php"), "utf8")).toHaveLength(1500);
    expect(existsSync(path.join(root, `wp-content/${"d".repeat(120)}/long.php`))).toBe(true);
  });

  it("never creates links, devices or files outside the root", async () => {
    const root = tempRoot();
    const tar = new TarToDisk(path.join(root, "files"));
    const archive = Buffer.concat([
      rawEntry("evil-link", "2", Buffer.alloc(0), "/etc/passwd"),
      rawEntry("hard-link", "1", Buffer.alloc(0), "index.php"),
      rawEntry("../outside.php", "0", Buffer.from("escape")),
      rawEntry("dev", "3"),
      rawEntry("ok.php", "0", Buffer.from("fine")),
      Buffer.alloc(1024),
    ]);
    await feed(tar, archive, 100);
    expect(tar.files).toBe(1);
    expect(existsSync(path.join(root, "outside.php"))).toBe(false);
    expect(existsSync(path.join(root, "files", "evil-link"))).toBe(false);
    expect(existsSync(path.join(root, "files", "hard-link"))).toBe(false);
    expect(existsSync(path.join(root, "files", "dev"))).toBe(false);
    expect(lstatSync(path.join(root, "files", "ok.php")).isFile()).toBe(true);
  });

  it("skips oversized files and stops at the limits", async () => {
    const root = tempRoot();
    const tar = new TarToDisk(root, { maxFiles: 2, maxTotalBytes: 1_000_000, maxFileBytes: 100 });
    const answer = await tar.push(
      packTar([
        { path: "big.php", data: Buffer.alloc(200, 1) },
        { path: "a.php", data: Buffer.from("a") },
        { path: "b.php", data: Buffer.from("b") },
        { path: "c.php", data: Buffer.from("c") },
      ]),
    );
    expect(answer).toBe("stop");
    expect(tar.skippedLarge).toBe(1);
    expect(tar.files).toBe(2);
    expect(tar.truncated).toBe(true);
    expect(existsSync(path.join(root, "c.php"))).toBe(false);
  });
});

describe("scanTarArgv", () => {
  it("reads the WordPress root, leaving out media, archives and caches", () => {
    const argv = scanTarArgv("/sites/shop");
    expect(argv.slice(0, 5)).toEqual(["tar", "-C", "/sites/shop", "-cf", "-"]);
    expect(argv.at(-1)).toBe(".");
    expect(argv).toContain("--exclude=*.jpg");
    expect(argv).toContain("--exclude=*.ZIP");
    expect(argv).toContain("--exclude=./wp-content/cache");
    // Code is never excluded.
    expect(argv.some((a) => /\.(php|js|ico|html|htaccess)$/.test(a))).toBe(false);
  });
});
