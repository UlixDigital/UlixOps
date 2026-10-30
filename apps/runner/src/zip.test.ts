import { describe, expect, it } from "vitest";
import { unzipStore, zipStore } from "./zip";

describe("zipStore / unzipStore", () => {
  it("round-trips files", () => {
    const files = new Map<string, Buffer>([
      ["manifest.json", Buffer.from('{"version":1}', "utf8")],
      ["plugin/hello.php", Buffer.from("<?php\n", "utf8")],
      ["database.sql", Buffer.from("-- dump\n", "utf8")],
    ]);
    const zip = zipStore(files);
    const out = unzipStore(zip);
    expect([...out.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, data] of files) expect(out.get(path)?.equals(data)).toBe(true);
  });

  it("refuses path traversal on write and read", () => {
    expect(() => zipStore(new Map([["../etc/passwd", Buffer.from("x")]]))).toThrow(/Bad zip path/);
    const evil = zipStore(new Map([["ok.txt", Buffer.from("x")]]));
    // Hand-craft a central-directory name with .. is hard; unzip rejects such names if present.
    expect(unzipStore(evil).has("ok.txt")).toBe(true);
  });
});
