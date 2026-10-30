import { describe, expect, it } from "vitest";
import { packTar, splitUstarPath, unpackTar } from "./tar";

function checksumHeader(header: Buffer): void {
  header.write("        ", 148, 8, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
}

/** Build a path that needs the ustar prefix field (>100 bytes, ≤255). */
function deepPath(file = "class-plugin.php"): string {
  const parts = [
    "includes",
    "modules",
    "analytics",
    "rest",
    "v1",
    "controllers",
    "admin",
    "views",
    "partials",
    file,
  ];
  const path = parts.join("/");
  expect(Buffer.byteLength(path, "utf8")).toBeGreaterThan(100);
  expect(Buffer.byteLength(path, "utf8")).toBeLessThanOrEqual(255);
  return path;
}

describe("packTar / unpackTar", () => {
  it("round-trips plugin files", () => {
    const files = [
      { path: "seo-by-rank-math.php", data: Buffer.from("<?php // main\n") },
      { path: "includes/foo.php", data: Buffer.from("<?php // foo\n") },
    ];
    const out = unpackTar(packTar(files), 100, 1_000_000);
    expect(out).toHaveLength(2);
    expect(out.find((f) => f.path === "seo-by-rank-math.php")?.data.toString()).toContain("main");
    expect(out.find((f) => f.path === "includes/foo.php")?.data.toString()).toContain("foo");
  });

  it("round-trips paths longer than 100 bytes via ustar prefix", () => {
    const deep = deepPath("class-rank-math-analytics-rest-controller.php");
    const files = [{ path: deep, data: Buffer.from("<?php // deep\n") }];
    const out = unpackTar(packTar(files), 100, 1_000_000);
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe(deep);
    expect(out[0]?.data.toString()).toContain("deep");
  });

  it("refuses paths that cannot fit in ustar name+prefix", () => {
    const tooLong = `${"abcd/".repeat(60)}file.php`;
    expect(Buffer.byteLength(tooLong, "utf8")).toBeGreaterThan(255);
    expect(() => packTar([{ path: tooLong, data: Buffer.from("x") }])).toThrow(/too long/);
  });

  it("refuses traversal in names when packing", () => {
    expect(() => packTar([{ path: "../evil.php", data: Buffer.from("x") }])).toThrow(
      /Bad tar path/,
    );
  });

  it("reads GNU LongLink entries instead of truncating", () => {
    const clean = deepPath("class-rank-math-long-name-controller.php");
    const cleanName = Buffer.from(`${clean}\0`);
    const body = Buffer.from("<?php ok\n");

    const longLinkHeader = Buffer.alloc(512);
    longLinkHeader.write("././@LongLink", 0);
    longLinkHeader.write("0000644\0", 100, 8, "utf8");
    longLinkHeader.write("0000000\0", 108, 8, "utf8");
    longLinkHeader.write("0000000\0", 116, 8, "utf8");
    longLinkHeader.write(`${cleanName.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
    longLinkHeader.write("00000000000\0", 136, 12, "utf8");
    longLinkHeader[156] = 76; // 'L'
    longLinkHeader.write("ustar  \0", 257, 8, "utf8");
    checksumHeader(longLinkHeader);

    const shortHeader = Buffer.alloc(512);
    shortHeader.write("truncated.php", 0);
    shortHeader.write("0000644\0", 100, 8, "utf8");
    shortHeader.write("0000000\0", 108, 8, "utf8");
    shortHeader.write("0000000\0", 116, 8, "utf8");
    shortHeader.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
    shortHeader.write("00000000000\0", 136, 12, "utf8");
    shortHeader[156] = 48;
    shortHeader.write("ustar  \0", 257, 8, "utf8");
    checksumHeader(shortHeader);

    const cleanPad = (512 - (cleanName.length % 512)) % 512;
    const bodyPad = (512 - (body.length % 512)) % 512;
    const archive = Buffer.concat([
      longLinkHeader,
      cleanName,
      Buffer.alloc(cleanPad),
      shortHeader,
      body,
      Buffer.alloc(bodyPad),
      Buffer.alloc(1024),
    ]);
    const out = unpackTar(archive, 100, 1_000_000);
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe(clean);
    expect(out[0]?.data.toString()).toContain("ok");
  });
});

describe("splitUstarPath", () => {
  it("keeps short paths in the name field", () => {
    expect(splitUstarPath("includes/foo.php")).toEqual({
      name: "includes/foo.php",
      prefix: "",
    });
  });

  it("splits long paths without truncating", () => {
    const deep = deepPath("class-rank-math-analytics-rest-controller.php");
    const split = splitUstarPath(deep);
    const joined = split.prefix ? `${split.prefix}/${split.name}` : split.name;
    expect(joined).toBe(deep);
    expect(Buffer.byteLength(split.name, "utf8")).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(split.prefix, "utf8")).toBeLessThanOrEqual(155);
  });
});
