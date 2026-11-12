import { afterEach, describe, expect, it } from "vitest";
import { handleJob } from "./jobs";
import { type PeerCertificate, resetRdapBootstrap, runExpiryChecks, type TlsProbe } from "./expiry";
import type { SshConnector } from "./ssh";
import type { Vault } from "./vault";

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const DAY = 24 * 60 * 60_000;
const iso = (t: number) => new Date(t).toISOString();

const goodCert = (over: Partial<PeerCertificate> = {}): PeerCertificate => ({
  validFrom: iso(NOW - 30 * DAY),
  validTo: iso(NOW + 60 * DAY),
  issuer: "Let's Encrypt · R11",
  subject: "example.com",
  altNames: ["example.com", "www.example.com"],
  authorized: true,
  authorizationError: null,
  identityError: null,
  ...over,
});

const BOOTSTRAP = {
  services: [
    [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
    [["uk"], ["https://rdap.nominet.uk/uk/"]],
    [["org"], ["http://rdap.insecure.example/"]],
  ],
};

const rdapDomain = (name: string, expires: string | null) => ({
  objectClassName: "domain",
  ldhName: name.toUpperCase(),
  events: [
    { eventAction: "registration", eventDate: "2015-01-01T00:00:00Z" },
    ...(expires ? [{ eventAction: "expiration", eventDate: expires }] : []),
  ],
  entities: [
    {
      roles: ["registrar"],
      vcardArray: [
        "vcard",
        [
          ["version", {}, "text", "4.0"],
          ["fn", {}, "text", "Example Registrar, LLC"],
        ],
      ],
    },
  ],
});

/** Fake RDAP: `domains` maps a name to its answer; anything else is a 404. */
function fakeFetch(domains: Record<string, unknown | number>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://data.iana.org/rdap/dns.json") return Response.json(BOOTSTRAP);
    const name = decodeURIComponent(url.split("/domain/")[1] ?? "");
    const answer = domains[name];
    if (answer === undefined) return new Response("", { status: 404 });
    if (typeof answer === "number") return new Response("", { status: answer });
    return Response.json(answer);
  }) as typeof fetch;
}

const run = (
  checks: Parameters<typeof runExpiryChecks>[0],
  opts: { probe?: TlsProbe; fetch?: typeof fetch } = {},
) =>
  runExpiryChecks(checks, {
    probe: opts.probe ?? (async () => goodCert()),
    fetch: opts.fetch ?? fakeFetch({}),
    now: () => NOW,
    retryDelayMs: 0,
  });

afterEach(() => resetRdapBootstrap());

describe("certificate checks", () => {
  it("reports a trusted certificate's dates and names", async () => {
    const out = await run([{ host: "example.com", port: 443, ssl: true, domain: false }]);
    expect(out.results[0]).toMatchObject({
      host: "example.com",
      domain: null,
      ssl: {
        ok: true,
        validTo: iso(NOW + 60 * DAY),
        issuer: "Let's Encrypt · R11",
        altNames: ["example.com", "www.example.com"],
        error: null,
      },
    });
  });

  it("explains expired, untrusted and wrong-name certificates", async () => {
    const certs: Record<string, PeerCertificate> = {
      "expired.com": goodCert({
        validTo: iso(NOW - DAY),
        authorized: false,
        authorizationError: "CERT_HAS_EXPIRED",
      }),
      "self.com": goodCert({
        authorized: false,
        authorizationError: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
      "chain.com": goodCert({
        authorized: false,
        authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      }),
      "name.com": goodCert({ identityError: "Host: name.com. is not in the cert's altnames" }),
    };
    const out = await run(
      Object.keys(certs).map((host) => ({ host, port: 443, ssl: true, domain: false })),
      { probe: async (host) => certs[host] ?? goodCert() },
    );
    const errors = Object.fromEntries(out.results.map((r) => [r.host, r.ssl?.error]));
    expect(out.results.every((r) => r.ssl?.ok === false)).toBe(true);
    expect(errors["expired.com"]).toBe("The certificate has expired.");
    expect(errors["self.com"]).toMatch(/self-signed/);
    expect(errors["chain.com"]).toMatch(/intermediate/);
    expect(errors["name.com"]).toBe("The certificate doesn't cover name.com.");
  });

  it("retries a failed handshake once, then reports the network error", async () => {
    let calls = 0;
    const flaky: TlsProbe = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return goodCert();
    };
    const ok = await run([{ host: "example.com", port: 443, ssl: true, domain: false }], {
      probe: flaky,
    });
    expect(ok.results[0]?.ssl?.ok).toBe(true);
    expect(calls).toBe(2);

    const down = await run([{ host: "example.com", port: 443, ssl: true, domain: false }], {
      probe: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      },
    });
    expect(down.results[0]?.ssl).toMatchObject({
      ok: false,
      validTo: null,
      error: "Couldn't connect over HTTPS: the host name doesn't resolve",
    });
  });
});

describe("domain lookups (RDAP)", () => {
  it("finds the registered domain from a subdomain and reads expiry + registrar", async () => {
    const calls: string[] = [];
    const out = await run([{ host: "www.example.com", port: 443, ssl: false, domain: true }], {
      fetch: fakeFetch({ "example.com": rdapDomain("example.com", "2027-03-01T04:00:00Z") }, calls),
    });
    expect(out.results[0]?.domain).toEqual({
      domain: "example.com",
      status: "found",
      expiresAt: "2027-03-01T04:00:00.000Z",
      registrar: "Example Registrar, LLC",
      error: null,
    });
    expect(calls).toEqual([
      "https://data.iana.org/rdap/dns.json",
      "https://rdap.verisign.com/com/v1/domain/www.example.com",
      "https://rdap.verisign.com/com/v1/domain/example.com",
    ]);
  });

  it("asks once per name when hosts share a domain, and caches the directory", async () => {
    const calls: string[] = [];
    const fetchFn = fakeFetch(
      { "example.com": rdapDomain("example.com", "2027-03-01T00:00:00Z") },
      calls,
    );
    await run(
      [
        { host: "example.com", port: 443, ssl: false, domain: true },
        { host: "www.example.com", port: 443, ssl: false, domain: true },
        { host: "example.com", port: 443, ssl: false, domain: true },
      ],
      { fetch: fetchFn },
    );
    expect(calls.filter((c) => c.endsWith("/domain/example.com"))).toHaveLength(1);
    await run([{ host: "example.com", port: 443, ssl: false, domain: true }], { fetch: fetchFn });
    expect(calls.filter((c) => c.endsWith("dns.json"))).toHaveLength(1);
  });

  it("handles co.uk style names", async () => {
    const out = await run([{ host: "shop.example.co.uk", port: 443, ssl: false, domain: true }], {
      fetch: fakeFetch({ "example.co.uk": rdapDomain("example.co.uk", "2028-01-01T00:00:00Z") }),
    });
    expect(out.results[0]?.domain?.domain).toBe("example.co.uk");
  });

  it("says when the registry has no RDAP, no expiry, or doesn't know the name", async () => {
    const out = await run(
      [
        { host: "example.de", port: 443, ssl: false, domain: true },
        { host: "noexpiry.com", port: 443, ssl: false, domain: true },
        { host: "unknown.com", port: 443, ssl: false, domain: true },
        // Only an http:// server is listed for .org: refused, so treated as unsupported.
        { host: "example.org", port: 443, ssl: false, domain: true },
      ],
      { fetch: fakeFetch({ "noexpiry.com": rdapDomain("noexpiry.com", null) }) },
    );
    const by = Object.fromEntries(out.results.map((r) => [r.host, r.domain]));
    expect(by["example.de"]).toMatchObject({ status: "unsupported", domain: "example.de" });
    expect(by["noexpiry.com"]).toMatchObject({
      status: "unsupported",
      domain: "noexpiry.com",
      expiresAt: null,
    });
    expect(by["unknown.com"]).toMatchObject({ status: "not_found" });
    expect(by["example.org"]).toMatchObject({ status: "unsupported" });
  });

  it("reports registry errors and rate limits without failing the job", async () => {
    const out = await run(
      [
        { host: "busy.com", port: 443, ssl: true, domain: true },
        { host: "broken.com", port: 443, ssl: false, domain: true },
      ],
      { fetch: fakeFetch({ "busy.com": 429, "broken.com": 503 }) },
    );
    expect(out.results[0]?.ssl?.ok).toBe(true);
    expect(out.results[0]?.domain).toMatchObject({
      status: "error",
      error: expect.stringMatching(/rate limiting/),
    });
    expect(out.results[1]?.domain).toMatchObject({
      status: "error",
      error: "The registry answered HTTP 503.",
    });
  });

  it("refuses redirects to plain HTTP", async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("dns.json")) return Response.json(BOOTSTRAP);
      return new Response("", { status: 302, headers: { location: "http://evil.example/x" } });
    }) as typeof fetch;
    const out = await run([{ host: "example.com", port: 443, ssl: false, domain: true }], {
      fetch: fetchFn,
    });
    expect(out.results[0]?.domain).toMatchObject({
      status: "error",
      error: expect.stringMatching(/non-HTTPS/),
    });
  });
});

describe("monitor.expiry job", () => {
  const deps = {
    vault: {} as Vault,
    ssh: {} as SshConnector,
    now: () => NOW,
    expiry: { probe: async () => goodCert(), fetch: fakeFetch({}), retryDelayMs: 0 },
  };

  it("runs without touching the vault or SSH", async () => {
    const out = await handleJob(
      {
        type: "monitor.expiry",
        checks: [{ host: "example.com", port: 443, ssl: true, domain: false }],
      },
      deps,
    );
    expect(out).toMatchObject({ results: [{ host: "example.com", ssl: { ok: true } }] });
  });

  it("refuses private and dev hosts before any connection", async () => {
    await expect(
      handleJob(
        {
          type: "monitor.expiry",
          checks: [{ host: "infisical", port: 443, ssl: true, domain: true }],
        },
        deps,
      ),
    ).rejects.toThrow();
  });
});
