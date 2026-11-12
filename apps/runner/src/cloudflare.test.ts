// Cloudflare jobs (A156) against an in-memory fake API: paging, record changes in order with a
// stop at the first failure, purge, and that the token never leaks into a result.
import { describe, expect, it } from "vitest";
import { handleJob } from "./jobs";
import { MemoryVault } from "./vault";

const TOKEN = "cfTOKEN_secret_value_1234567890";
const ZONE = "a".repeat(32);
const hex = (n: number) => n.toString(16).padStart(32, "0");

function vault(withToken = true) {
  const v = new MemoryVault();
  if (withToken)
    v.secrets.set("CLOUDFLARE_API_TOKEN", { value: TOKEN, at: new Date().toISOString() });
  return v;
}

/** A tiny Cloudflare: one zone, its records, and a log of calls. */
function fakeCloudflare() {
  let n = 100;
  const records = new Map<string, Record<string, unknown>>([
    [
      hex(1),
      { id: hex(1), type: "A", name: "example.com", content: "1.2.3.4", ttl: 1, proxied: true },
    ],
    [
      hex(2),
      { id: hex(2), type: "NS", name: "sub.example.com", content: "ns1.other.net", ttl: 3600 },
    ],
  ]);
  const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  let failOn: string | null = null;
  const reply = (status: number, result: unknown, info?: unknown) =>
    new Response(
      JSON.stringify({
        success: status < 400,
        errors: status < 400 ? [] : [{ code: 9000, message: `bad request, token ${TOKEN}` }],
        result,
        result_info: info,
      }),
      { status },
    );
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, auth: new Headers(init.headers).get("authorization"), body });
    if (failOn && `${method} ${path}`.includes(failOn)) return reply(400, null);
    if (path === "/zones") {
      const page = Number(url.searchParams.get("page"));
      const zone = (i: number) => ({
        id: i === 1 ? ZONE : "b".repeat(32),
        name: i === 1 ? "example.com" : "other.org",
        status: "active",
        account: { name: "Ulix Digital" },
        plan: { name: "Free Website" },
        name_servers: ["ana.ns.cloudflare.com", "bob.ns.cloudflare.com"],
        original_name_servers: ["ns1.godaddy.com"],
      });
      return reply(200, [zone(page)], { total_pages: 2 });
    }
    if (path === `/zones/${ZONE}/dns_records` && method === "GET")
      return reply(200, [...records.values()], { total_pages: 1 });
    if (path === `/zones/${ZONE}/dns_records` && method === "POST") {
      const id = hex(++n);
      records.set(id, { id, ...body });
      return reply(200, { id });
    }
    const m = /^\/zones\/[a-f0-9]{32}\/dns_records\/([a-f0-9]{32})$/.exec(path);
    if (m?.[1] && method === "PUT") {
      records.set(m[1], { id: m[1], ...body });
      return reply(200, { id: m[1] });
    }
    if (m?.[1] && method === "DELETE") {
      records.delete(m[1]);
      return reply(200, { id: m[1] });
    }
    if (path === `/zones/${ZONE}/purge_cache`) return reply(200, { id: ZONE });
    return reply(404, null);
  };
  return {
    fetchImpl,
    calls,
    records,
    failOn: (s: string | null) => {
      failOn = s;
    },
  };
}

const run = (job: unknown, cf: ReturnType<typeof fakeCloudflare>, v = vault()) =>
  handleJob(job, {
    vault: v,
    ssh: { connect: async () => Promise.reject(new Error("no ssh")) },
    cloudflareFetch: cf.fetchImpl,
  });

describe("Cloudflare jobs", () => {
  it("lists every zone across pages with the token as a bearer header only", async () => {
    const cf = fakeCloudflare();
    const r = (await run({ type: "dns.zones" }, cf)) as { ok: true; zones: { name: string }[] };
    expect(r.ok).toBe(true);
    expect(r.zones.map((z) => z.name)).toEqual(["example.com", "other.org"]);
    expect(r.zones[0]).toMatchObject({
      accountName: "Ulix Digital",
      nameServers: ["ana.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      originalNameServers: ["ns1.godaddy.com"],
    });
    expect(cf.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("reads records, keeping read-only types too", async () => {
    const cf = fakeCloudflare();
    const r = (await run({ type: "dns.records", zoneId: ZONE }, cf)) as {
      ok: true;
      records: { type: string; proxied: boolean }[];
    };
    expect(r.records.map((x) => x.type)).toEqual(["A", "NS"]);
    expect(r.records[1]?.proxied).toBe(false);
  });

  it("applies changes in order and stops at the first failure, without the token", async () => {
    const cf = fakeCloudflare();
    const record = {
      type: "TXT",
      name: "example.com",
      content: "v=spf1 include:_spf.google.com ~all",
      ttl: 1,
      proxied: false,
      priority: null,
      comment: null,
    };
    cf.failOn(`DELETE /zones/${ZONE}/dns_records/${hex(1)}`);
    const r = await run(
      {
        type: "dns.apply",
        zoneId: ZONE,
        changes: [
          { op: "create", record },
          { op: "delete", id: hex(1) },
          { op: "create", record: { ...record, content: "never sent" } },
        ],
      },
      cf,
    );
    expect(r).toMatchObject({ applied: 1, failed: { index: 1 } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).toContain("[redacted]");
    expect(cf.calls.filter((c) => c.method !== "GET")).toHaveLength(2);
    expect(cf.calls[0]?.body).toMatchObject({ type: "TXT", comment: "" });
  });

  it("refuses bad changes before calling Cloudflare", async () => {
    const cf = fakeCloudflare();
    for (const record of [
      {
        type: "A",
        name: "www.example.com",
        content: "not-an-ip",
        ttl: 1,
        proxied: false,
        priority: null,
        comment: null,
      },
      {
        type: "TXT",
        name: "example.com",
        content: "two\nlines",
        ttl: 1,
        proxied: false,
        priority: null,
        comment: null,
      },
      {
        type: "TXT",
        name: "example.com",
        content: "x",
        ttl: 1,
        proxied: true,
        priority: null,
        comment: null,
      },
      {
        type: "MX",
        name: "example.com",
        content: "mx.example.com",
        ttl: 1,
        proxied: false,
        priority: null,
        comment: null,
      },
      {
        type: "NS",
        name: "example.com",
        content: "ns.example.com",
        ttl: 1,
        proxied: false,
        priority: null,
        comment: null,
      },
    ])
      await expect(
        run({ type: "dns.apply", zoneId: ZONE, changes: [{ op: "create", record }] }, cf),
      ).rejects.toThrow();
    await expect(run({ type: "dns.records", zoneId: "../zones" }, cf)).rejects.toThrow();
    expect(cf.calls).toHaveLength(0);
  });

  it("purges everything or a list of URLs", async () => {
    const cf = fakeCloudflare();
    expect(await run({ type: "dns.purge", zoneId: ZONE, everything: true, urls: [] }, cf)).toEqual({
      ok: true,
    });
    await run(
      { type: "dns.purge", zoneId: ZONE, everything: false, urls: ["https://example.com/a"] },
      cf,
    );
    expect(cf.calls.map((c) => c.body)).toEqual([
      { purge_everything: true },
      { files: ["https://example.com/a"] },
    ]);
  });

  it("says plainly when there is no token", async () => {
    const cf = fakeCloudflare();
    expect(await run({ type: "dns.zones" }, cf, vault(false))).toEqual({
      ok: false,
      error: "No Cloudflare API token in the vault (Settings → Credentials).",
    });
    expect(cf.calls).toHaveLength(0);
  });
});
