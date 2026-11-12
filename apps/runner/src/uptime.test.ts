import { describe, expect, it } from "vitest";
import { handleJob } from "./jobs";
import type { SshConnector } from "./ssh";
import { probeOnce, runUptimeProbes } from "./uptime";
import type { Vault } from "./vault";

type Handler = (url: string) => Response | Promise<Response>;

/** Fake fetch: no real site is ever contacted. */
function fakeFetch(handler: Handler, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.redirect !== "manual") throw new Error("redirects must be followed by hand");
    return handler(url);
  }) as typeof fetch;
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html" } });
const redirect = (location: string, status = 301) =>
  new Response(null, { status, headers: { location } });

const probe = (url: string, sshHost = "ssh.example.com") => ({ id: "env1", url, sshHost });
const deps = (handler: Handler, calls?: string[]) => ({
  fetch: fakeFetch(handler, calls),
  retryDelayMs: 0,
});

describe("uptime probes", () => {
  it("reports a normal page as up with its status and timing", async () => {
    let t = 1_000;
    const result = await probeOnce(probe("https://www.example.com/"), {
      fetch: fakeFetch(() => {
        t += 240;
        return html("<html><body>Welcome</body></html>");
      }),
      now: () => t,
    });
    expect(result).toEqual({ id: "env1", ok: true, status: 200, responseMs: 240, error: null });
  });

  it("counts 401/403/404 as up (the server answers) and 5xx as down", async () => {
    for (const [status, ok] of [
      [401, true],
      [403, true],
      [404, true],
      [500, false],
      [502, false],
      [503, false],
    ] as const) {
      const r = await probeOnce(
        probe("https://www.example.com/"),
        deps(() => html("x", status)),
      );
      expect(r.ok, `HTTP ${status}`).toBe(ok);
      expect(r.status).toBe(status);
      expect(r.error).toBe(ok ? null : `HTTP ${status}`);
    }
  });

  it("counts a 200 WordPress critical-error page as down", async () => {
    const r = await probeOnce(
      probe("https://www.example.com/"),
      deps(() => html("<p>There has been a critical error on this website.</p>")),
    );
    expect(r).toMatchObject({ ok: false, status: 200 });
    expect(r.error).toMatch(/PHP \/ WordPress error/);
  });

  it("follows redirects to public hosts, and refuses ones into private networks", async () => {
    const calls: string[] = [];
    const ok = await probeOnce(
      probe("http://example.com/"),
      deps((url) => {
        if (url === "http://example.com/") return redirect("https://www.example.com/");
        return html("home");
      }, calls),
    );
    expect(ok).toMatchObject({ ok: true, status: 200 });
    expect(calls).toEqual(["http://example.com/", "https://www.example.com/"]);

    for (const target of [
      "http://redis:6379/",
      "http://infisical:8080/",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
    ]) {
      const fetched: string[] = [];
      const r = await probeOnce(
        probe("https://www.example.com/"),
        deps(() => redirect(target, 302), fetched),
      );
      expect(r.ok, target).toBe(false);
      expect(r.error).toBe("Redirects to an address that isn't public");
      expect(fetched).toHaveLength(1);
    }

    // A loopback redirect means the site's own server: it goes to the SSH host, never the hub.
    const own: string[] = [];
    await probeOnce(
      probe("https://www.example.com/"),
      deps((url) => (url.includes("localhost") ? html("x") : redirect("http://localhost/")), own),
    );
    expect(own[1]).toBe("http://ssh.example.com/");
  });

  it("gives up after 5 redirects", async () => {
    let n = 0;
    const r = await probeOnce(
      probe("https://www.example.com/"),
      deps(() => redirect(`https://www.example.com/${++n}`)),
    );
    expect(r).toMatchObject({ ok: false, error: "Too many redirects" });
    expect(n).toBe(6);
  });

  it("reaches local test containers through the SSH host (dev only)", async () => {
    const calls: string[] = [];
    const r = await probeOnce(
      probe("http://localhost:8080/", "test-wp"),
      deps((url) => {
        if (url === "http://test-wp/") return redirect("http://localhost:8080/home/");
        return html("ok");
      }, calls),
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["http://test-wp/", "http://test-wp/home/"]);
  });

  it("explains network failures and timeouts in plain words", async () => {
    const refused = await probeOnce(
      probe("https://www.example.com/"),
      deps(() => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
        });
      }),
    );
    expect(refused).toMatchObject({ ok: false, status: null, error: "Connection refused" });

    const slow = await probeOnce(probe("https://www.example.com/"), {
      timeoutMs: 20,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as typeof fetch,
    });
    expect(slow).toMatchObject({ ok: false, status: null, error: "No answer within 0 s" });
  });

  it("retries a failed probe once, so one dropped request isn't a failed check", async () => {
    let n = 0;
    const blip = await runUptimeProbes(
      [probe("https://www.example.com/")],
      deps(() => (++n === 1 ? html("x", 502) : html("ok"))),
    );
    expect(blip.results[0]).toMatchObject({ ok: true, status: 200 });
    expect(n).toBe(2);

    let m = 0;
    const down = await runUptimeProbes(
      [probe("https://www.example.com/")],
      deps(() => {
        m++;
        return html("x", 503);
      }),
    );
    expect(down.results[0]).toMatchObject({ ok: false, status: 503 });
    expect(m).toBe(2);
  });

  it("probes many sites and keeps results in order", async () => {
    const probes = Array.from({ length: 25 }, (_, i) => ({
      id: `env${i}`,
      url: `https://site${i}.example.com/`,
      sshHost: "ssh.example.com",
    }));
    const out = await runUptimeProbes(
      probes,
      deps((url) => (url.includes("site7.") ? html("x", 500) : html("ok"))),
    );
    expect(out.results.map((r) => r.id)).toEqual(probes.map((p) => p.id));
    expect(out.results.filter((r) => !r.ok).map((r) => r.id)).toEqual(["env7"]);
  });

  it("is reachable through handleJob, which validates the job again", async () => {
    const runnerDeps = {
      vault: {} as Vault,
      ssh: {} as SshConnector,
      uptime: deps(() => html("ok")),
    };
    const result = await handleJob(
      { type: "monitor.uptime", probes: [probe("https://www.example.com/")] },
      runnerDeps,
    );
    expect(result).toMatchObject({ results: [{ id: "env1", ok: true, status: 200 }] });
    await expect(
      handleJob({ type: "monitor.uptime", probes: [probe("javascript:alert(1)")] }, runnerDeps),
    ).rejects.toThrow();
  });
});
