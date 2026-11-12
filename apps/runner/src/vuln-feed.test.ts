import { softwareKey, VulnFeedResult, WORDFENCE_KEY_REF } from "@ulixops/shared";
import { describe, expect, it } from "vitest";
import { MemoryVault } from "./vault";
import { filterFeed, readVulnFeed, topLevelObjects } from "./vuln-feed";

async function* chunked(text: string, size: number): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const record = (id: string, slug: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Issue in ${slug} with "quotes" and {braces} [brackets] \\ backslash`,
  software: [
    {
      type: "plugin",
      name: slug,
      slug,
      affected_versions: {
        "* - 2.0": {
          from_version: "*",
          from_inclusive: true,
          to_version: "2.0",
          to_inclusive: true,
        },
      },
      patched: true,
      patched_versions: ["2.1"],
    },
  ],
  informational: false,
  references: [`https://www.wordfence.com/threat-intel/vulnerabilities/id/${id}`],
  published: "2025-01-02 03:04:05",
  cve: null,
  cvss: { score: 7.5, rating: "High" },
  ...over,
});

const ID_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ID_B = "bbbbbbbb-0000-0000-0000-000000000002";
const ID_C = "cccccccc-0000-0000-0000-000000000003";

const feed = JSON.stringify({
  [ID_A]: record(ID_A, "akismet"),
  [ID_B]: record(ID_B, "not-installed"),
  [ID_C]: record(ID_C, "akismet", { informational: true }),
});

describe("topLevelObjects", () => {
  it.each([1, 2, 7, 64, 100_000])("splits records correctly with %i-char chunks", async (size) => {
    const records = await collect(topLevelObjects(chunked(feed, size)));
    expect(records.map((r) => (JSON.parse(r) as { id: string }).id)).toEqual([ID_A, ID_B, ID_C]);
  });

  it("also reads a top-level array", async () => {
    const records = await collect(
      topLevelObjects(chunked(JSON.stringify([{ a: 1 }, { b: [2] }]), 3)),
    );
    expect(records).toEqual(['{"a":1}', '{"b":[2]}']);
  });

  it("rejects a truncated stream", async () => {
    await expect(collect(topLevelObjects(chunked(feed.slice(0, -10), 50)))).rejects.toThrow(
      /ended early/,
    );
  });

  it("rejects unbalanced JSON", async () => {
    await expect(collect(topLevelObjects(chunked("{}}", 1)))).rejects.toThrow(/Unbalanced/);
  });
});

describe("filterFeed", () => {
  it("keeps only wanted, non-informational records and counts them all", async () => {
    const result = await filterFeed(chunked(feed, 13), new Set([softwareKey("plugin", "akismet")]));
    expect(result.total).toBe(3);
    expect(result.records.map((r) => r.id)).toEqual([ID_A]);
    expect(result.records[0]).toMatchObject({ severity: "high", cvssScore: 7.5 });
  });

  it("skips records that aren't valid JSON or don't fit the schema", async () => {
    const text = `{"x": {"id": 5}, "y": ${JSON.stringify(record(ID_A, "akismet"))}}`;
    const result = await filterFeed(chunked(text, 9), new Set(["plugin:akismet"]));
    expect(result.total).toBe(2);
    expect(result.records).toHaveLength(1);
  });
});

describe("readVulnFeed", () => {
  const KEY = "wf_test_key_0123456789abcdef";
  const vaultWithKey = () => {
    const vault = new MemoryVault();
    vault.secrets.set(WORDFENCE_KEY_REF, { value: `${KEY}\n`, at: new Date().toISOString() });
    return vault;
  };
  const wanted = [{ type: "plugin" as const, slug: "akismet" }];

  it("sends the key as a bearer token and returns matching records", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(feed, { status: 200 });
    }) as typeof fetch;
    const result = await readVulnFeed(wanted, {
      vault: vaultWithKey(),
      fetchImpl,
      now: () => Date.parse("2026-10-31T00:00:00Z"),
    });
    expect(VulnFeedResult.parse(result)).toMatchObject({
      ok: true,
      total: 3,
      fetchedAt: "2026-10-31T00:00:00.000Z",
    });
    expect(seen).toEqual([
      {
        url: "https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production",
        auth: `Bearer ${KEY}`,
      },
    ]);
  });

  it("explains a missing key without calling Wordfence", async () => {
    let called = false;
    const result = await readVulnFeed(wanted, {
      vault: new MemoryVault(),
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "not_configured" });
    expect(called).toBe(false);
  });

  it("reports a rejected key and never echoes it", async () => {
    const result = await readVulnFeed(wanted, {
      vault: vaultWithKey(),
      fetchImpl: (async () => new Response("denied", { status: 401 })) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("reports network failures and broken feeds", async () => {
    const down = await readVulnFeed(wanted, {
      vault: vaultWithKey(),
      fetchImpl: (async () => {
        throw new Error(`connect failed ${KEY}`);
      }) as typeof fetch,
    });
    expect(down).toMatchObject({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(down)).not.toContain(KEY);

    const broken = await readVulnFeed(wanted, {
      vault: vaultWithKey(),
      fetchImpl: (async () => new Response(feed.slice(0, 200))) as typeof fetch,
    });
    expect(broken).toMatchObject({ ok: false, reason: "invalid" });

    const empty = await readVulnFeed(wanted, {
      vault: vaultWithKey(),
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    });
    expect(empty).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("refuses a vault value that isn't a key", async () => {
    const vault = new MemoryVault();
    vault.secrets.set(WORDFENCE_KEY_REF, { value: "has spaces in it!", at: "" });
    expect(await readVulnFeed(wanted, { vault })).toMatchObject({
      ok: false,
      reason: "not_configured",
    });
  });
});
