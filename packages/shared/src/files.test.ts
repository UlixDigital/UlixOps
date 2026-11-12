import { describe, expect, it } from "vitest";
import { FileName, isSecretRelPath, RelPath, SiteFilesOp, FILES_MAX_BYTES } from "./files";
import { RunnerJob } from "./queue";

const target = {
  host: "test-wp",
  port: 22,
  user: "wpdev",
  wpPath: "/var/www/html",
  credentialRef: "SSH_KEY_TEST",
  hostKey: null,
};

describe("RelPath", () => {
  it.each(["", "wp-config.php", "wp-content/plugins/hello.php", "a/b/c-1._d"])(
    "accepts %j",
    (p) => {
      expect(RelPath.safeParse(p).success).toBe(true);
    },
  );

  it.each([
    "../etc/passwd",
    "/absolute",
    "wp-content/../wp-config.php",
    "has space",
    "semi;colon",
    "a//b",
    "./x",
    "x/./y",
  ])("rejects %j", (p) => {
    expect(RelPath.safeParse(p).success).toBe(false);
  });
});

describe("FileName", () => {
  it("accepts a single segment", () => {
    expect(FileName.safeParse("wp-config.php").success).toBe(true);
  });
  it.each(["a/b", "", "..", ".env;id"])("rejects %j", (n) => {
    expect(FileName.safeParse(n).success).toBe(false);
  });
});

describe("isSecretRelPath", () => {
  it.each([
    "wp-config.php",
    ".env",
    ".env.local",
    "ssl/private.key",
    "certs/site.pem",
    "id_rsa",
    "id_ed25519",
  ])("flags %j", (p) => {
    expect(isSecretRelPath(p)).toBe(true);
  });

  it.each(["index.php", "wp-content/themes/twentytwentyfour/style.css", ""])(
    "does not flag %j",
    (p) => {
      expect(isSecretRelPath(p)).toBe(false);
    },
  );
});

describe("site.files job", () => {
  it("accepts list/read/write/mkdir/delete/rename", () => {
    for (const op of [
      { kind: "list" as const, path: "" },
      { kind: "read" as const, path: "wp-config.php" },
      {
        kind: "write" as const,
        path: "wp-content/mu-plugins/note.txt",
        contentBase64: Buffer.from("hi").toString("base64"),
      },
      { kind: "mkdir" as const, path: "wp-content/uploads/custom" },
      { kind: "delete" as const, path: "wp-content/uploads/x.jpg", recursive: false },
      { kind: "rename" as const, from: "a.php", to: "b.php" },
    ]) {
      expect(SiteFilesOp.safeParse(op).success).toBe(true);
      expect(RunnerJob.safeParse({ type: "site.files", target, op }).success).toBe(true);
    }
  });

  it("rejects oversized write payloads and path escape", () => {
    const huge = "A".repeat(FILES_MAX_BYTES * 2);
    expect(
      SiteFilesOp.safeParse({
        kind: "write",
        path: "big.bin",
        contentBase64: huge,
      }).success,
    ).toBe(false);
    expect(
      RunnerJob.safeParse({
        type: "site.files",
        target,
        op: { kind: "list", path: "../etc" },
      }).success,
    ).toBe(false);
  });
});
