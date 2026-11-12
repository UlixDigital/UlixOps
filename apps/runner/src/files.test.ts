import { FILES_MAX_BYTES } from "@ulixops/shared";
import { describe, expect, it, vi } from "vitest";
import { resolveUnderWp, runSiteFiles } from "./files";
import type { SftpDirEntry, SftpSession, SshSession } from "./ssh";

const target = {
  host: "test-wp",
  port: 22,
  user: "wpdev",
  wpPath: "/var/www/html",
  credentialRef: "SSH_KEY_TEST",
  hostKey: null,
};

function fakeSftp(store: Map<string, { dir?: boolean; data?: Buffer }>): SftpSession {
  const abs = (p: string) => p.replace(/\/$/, "") || "/";
  return {
    async stat(remotePath) {
      const hit = store.get(abs(remotePath));
      if (!hit) return null;
      return {
        isDirectory: Boolean(hit.dir),
        size: hit.data?.length ?? 0,
      };
    },
    async readFile(remotePath) {
      const hit = store.get(abs(remotePath));
      if (!hit?.data) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return hit.data;
    },
    readFileHead: vi.fn(),
    readFileTail: vi.fn(),
    async writeFile(remotePath, data) {
      store.set(abs(remotePath), { data: Buffer.from(data) });
    },
    async mkdirp(remotePath) {
      const parts = abs(remotePath).split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) {
        cur += `/${part}`;
        store.set(cur, { dir: true });
      }
    },
    async listDir(remotePath): Promise<SftpDirEntry[]> {
      const root = abs(remotePath);
      const prefix = `${root}/`;
      const out: SftpDirEntry[] = [];
      for (const [path, hit] of store) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;
        out.push({
          name: rest,
          isDirectory: Boolean(hit.dir),
          isFile: !hit.dir,
          size: hit.data?.length ?? 0,
          mtime: 1_700_000_000,
        });
      }
      return out;
    },
    readTree: vi.fn(),
    writeTree: vi.fn(),
    async rename(from, to) {
      const hit = store.get(abs(from));
      if (!hit) throw new Error("missing");
      store.delete(abs(from));
      store.set(abs(to), hit);
    },
    async unlink(remotePath) {
      store.delete(abs(remotePath));
    },
    async rmTree(remotePath) {
      const root = abs(remotePath);
      for (const key of [...store.keys()]) {
        if (key === root || key.startsWith(`${root}/`)) store.delete(key);
      }
    },
    close: vi.fn(),
  };
}

function session(store: Map<string, { dir?: boolean; data?: Buffer }>): SshSession {
  const sftp = fakeSftp(store);
  return {
    hostKey: `SHA256:${"B".repeat(43)}`,
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    sftp: async () => sftp,
    close: vi.fn(),
  };
}

describe("resolveUnderWp", () => {
  it("joins under the WordPress root", () => {
    expect(resolveUnderWp("/var/www/html", "")).toBe("/var/www/html");
    expect(resolveUnderWp("/var/www/html/", "wp-config.php")).toBe("/var/www/html/wp-config.php");
    expect(resolveUnderWp("/var/www/html", "wp-content/plugins")).toBe(
      "/var/www/html/wp-content/plugins",
    );
  });

  it("refuses path escape via RelPath", () => {
    expect(() => resolveUnderWp("/var/www/html", "../etc/passwd")).toThrow();
  });
});

describe("runSiteFiles", () => {
  it("lists directories and reads text including wp-config.php", async () => {
    const store = new Map<string, { dir?: boolean; data?: Buffer }>([
      ["/var/www/html", { dir: true }],
      ["/var/www/html/wp-config.php", { data: Buffer.from("<?php // secret DB_PASSWORD") }],
      ["/var/www/html/index.php", { data: Buffer.from("<?php") }],
      ["/var/www/html/wp-content", { dir: true }],
    ]);
    const listed = await runSiteFiles(session(store), target, { kind: "list", path: "" });
    expect(listed).toMatchObject({ hostKeyMismatch: false, kind: "list", truncated: false });
    if (listed.hostKeyMismatch || listed.kind !== "list") throw new Error("expected list");
    expect(listed.entries.map((e) => e.name).sort()).toEqual([
      "index.php",
      "wp-config.php",
      "wp-content",
    ]);

    const read = await runSiteFiles(session(store), target, {
      kind: "read",
      path: "wp-config.php",
    });
    expect(read).toMatchObject({
      hostKeyMismatch: false,
      kind: "read",
      binary: false,
      secret: true,
      encoding: "utf8",
    });
    if (read.hostKeyMismatch || read.kind !== "read") throw new Error("expected read");
    expect(read.content).toContain("DB_PASSWORD");
  });

  it("writes, renames and deletes under wpPath", async () => {
    const store = new Map<string, { dir?: boolean; data?: Buffer }>([
      ["/var/www/html", { dir: true }],
      ["/var/www/html/wp-content", { dir: true }],
    ]);
    const s = session(store);
    const wrote = await runSiteFiles(s, target, {
      kind: "write",
      path: "wp-content/note.txt",
      contentBase64: Buffer.from("hello").toString("base64"),
    });
    expect(wrote).toMatchObject({ kind: "mutate", ok: true, bytes: 5 });
    expect(store.get("/var/www/html/wp-content/note.txt")?.data?.toString()).toBe("hello");

    const renamed = await runSiteFiles(s, target, {
      kind: "rename",
      from: "wp-content/note.txt",
      to: "wp-content/hello.txt",
    });
    expect(renamed).toMatchObject({ kind: "mutate", ok: true });
    expect(store.has("/var/www/html/wp-content/note.txt")).toBe(false);

    const deleted = await runSiteFiles(s, target, {
      kind: "delete",
      path: "wp-content/hello.txt",
      recursive: false,
    });
    expect(deleted).toMatchObject({ kind: "mutate", ok: true });
    expect(store.has("/var/www/html/wp-content/hello.txt")).toBe(false);
  });

  it("refuses deleting the WordPress root and oversize writes", async () => {
    const store = new Map([["/var/www/html", { dir: true }]]);
    const s = session(store);
    const root = await runSiteFiles(s, target, { kind: "delete", path: "", recursive: true });
    expect(root.hostKeyMismatch).toBe(false);
    if (root.hostKeyMismatch) throw new Error("unexpected");
    expect(root).toMatchObject({ kind: "mutate", ok: false });
    if (root.kind !== "mutate" || root.ok) throw new Error("expected fail");
    expect(root.detail).toMatch(/WordPress root/);

    const big = Buffer.alloc(FILES_MAX_BYTES + 1, 1).toString("base64");
    // Job schema would refuse this; the handler also checks decoded length.
    const over = await runSiteFiles(s, target, {
      kind: "write",
      path: "huge.bin",
      contentBase64: big,
    });
    expect(over.hostKeyMismatch).toBe(false);
    if (over.hostKeyMismatch) throw new Error("unexpected");
    expect(over).toMatchObject({ kind: "mutate", ok: false });
    if (over.kind !== "mutate" || over.ok) throw new Error("expected fail");
    expect(over.detail).toMatch(/exceeds/);
  });

  it("creates directories and recursively deletes them", async () => {
    const store = new Map<string, { dir?: boolean; data?: Buffer }>([
      ["/var/www/html", { dir: true }],
    ]);
    const s = session(store);
    const made = await runSiteFiles(s, target, {
      kind: "mkdir",
      path: "wp-content/uploads/custom",
    });
    expect(made).toMatchObject({ kind: "mutate", ok: true });
    expect(store.get("/var/www/html/wp-content/uploads/custom")?.dir).toBe(true);

    store.set("/var/www/html/wp-content/uploads/custom/a.txt", { data: Buffer.from("x") });
    const wiped = await runSiteFiles(s, target, {
      kind: "delete",
      path: "wp-content/uploads/custom",
      recursive: true,
    });
    expect(wiped).toMatchObject({ kind: "mutate", ok: true });
    expect(store.has("/var/www/html/wp-content/uploads/custom")).toBe(false);
    expect(store.has("/var/www/html/wp-content/uploads/custom/a.txt")).toBe(false);
  });
});
