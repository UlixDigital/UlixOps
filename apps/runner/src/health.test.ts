import { describe, expect, it, vi } from "vitest";
import { runHealthCheck } from "./health";
import type { SshSession } from "./ssh";

function session(opts: {
  hostKey?: string;
  stat?: { isDirectory: boolean } | null;
  tail?: Buffer;
  tailError?: Error;
}): SshSession {
  const sftp = {
    stat: vi.fn(async () => opts.stat ?? null),
    readFileTail: vi.fn(async () => {
      if (opts.tailError) throw opts.tailError;
      return opts.tail ?? Buffer.from("");
    }),
    close: vi.fn(),
  };
  return {
    hostKey: opts.hostKey ?? `SHA256:${"B".repeat(43)}`,
    exec: vi.fn(),
    sftp: vi.fn(async () => sftp),
    close: vi.fn(),
  } as unknown as SshSession;
}

const target = {
  host: "test-wp",
  port: 22,
  user: "wpdev",
  wpPath: "/var/www/html",
  credentialRef: "SSH_KEY_TEST",
  hostKey: `SHA256:${"B".repeat(43)}`,
};

describe("runHealthCheck", () => {
  it("marks home and wp-admin ok on 200 with a login form", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const body = url.includes("wp-admin")
        ? '<form><input name="log" id="user_login" /></form>'
        : "<html><body>Home</body></html>";
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runHealthCheck(
      session({ stat: null }),
      target,
      {
        urls: ["https://shop.example.test/", "https://shop.example.test/wp-admin/"],
        origin: "https://shop.example.test",
        thresholdMs: 5_000,
        checkErrorLog: true,
      },
      () => 1_000,
    );

    expect(result).toMatchObject({
      hostKeyMismatch: false,
      ok: true,
      urls: [
        { role: "home", ok: true, status: 200 },
        { role: "wp-admin", ok: true, status: 200 },
      ],
      errorLog: { skipped: true, ok: true },
    });
    expect(result.summary).toMatch(/^Healthy\./);
    vi.unstubAllGlobals();
  });

  it("fails on critical-error body text and on recent fatals in debug.log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("There has been a critical error on this website.", { status: 200 }),
      ),
    );
    const result = await runHealthCheck(
      session({
        stat: { isDirectory: false },
        tail: Buffer.from("[29-Oct-2026] PHP Fatal error: Allowed memory size of\n"),
      }),
      target,
      {
        urls: ["https://shop.example.test/"],
        origin: "https://shop.example.test",
        thresholdMs: 5_000,
        checkErrorLog: true,
      },
      () => 1_000,
    );
    expect(result.ok).toBe(false);
    expect(result.urls[0]?.criticalText).toBe(true);
    expect(result.errorLog).toMatchObject({ ok: false, fatalLines: 1, skipped: false });
    vi.unstubAllGlobals();
  });

  it("fails when slower than the threshold", async () => {
    let t = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const result = await runHealthCheck(
      session({}),
      target,
      {
        urls: ["https://shop.example.test/"],
        origin: "https://shop.example.test",
        thresholdMs: 100,
        checkErrorLog: false,
      },
      () => {
        t += 200;
        return t;
      },
    );
    expect(result.ok).toBe(false);
    expect(result.urls[0]?.detail).toMatch(/Slower than 100 ms/);
    expect(result.errorLog.skipped).toBe(true);
    vi.unstubAllGlobals();
  });
});
