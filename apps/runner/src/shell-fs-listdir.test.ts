import { describe, expect, it } from "vitest";
import { parseLsLong } from "./shell-fs";

describe("parseLsLong", () => {
  it("parses GNU ls -la --time-style=+%s", () => {
    const out = parseLsLong(`total 48
drwxr-xr-x  5 wpe-user wpe-user 4096 1700000000 wp-admin
-rw-r--r--  1 wpe-user wpe-user  495 1700000001 index.php
lrwxrwxrwx  1 wpe-user wpe-user   11 1700000002 link -> somewhere
`);
    expect(out).toEqual([
      {
        name: "wp-admin",
        isDirectory: true,
        isFile: false,
        size: 4096,
        mtime: 1_700_000_000,
      },
      {
        name: "index.php",
        isDirectory: false,
        isFile: true,
        size: 495,
        mtime: 1_700_000_001,
      },
      {
        name: "link",
        isDirectory: false,
        isFile: false,
        size: 11,
        mtime: 1_700_000_002,
      },
    ]);
  });

  it("parses classic ls -la date columns", () => {
    const out = parseLsLong(`total 20
drwxr-xr-x. 12 wpe-user wpe-user 4096 Mar  3 12:01 wp-content
-rw-r--r--.  1 wpe-user wpe-user 3205 Jan  9  2024 wp-config.php
`);
    expect(out.map((e) => e.name)).toEqual(["wp-content", "wp-config.php"]);
    expect(out[0]).toMatchObject({ isDirectory: true, isFile: false });
    expect(out[1]).toMatchObject({ isDirectory: false, isFile: true, size: 3205 });
  });

  it("strips ANSI colour codes", () => {
    const out = parseLsLong(
      `-rw-r--r-- 1 u g 10 1700000000 \u001b[0m\u001b[01;34mindex.php\u001b[0m\n`,
    );
    expect(out[0]?.name).toBe("index.php");
  });
});
