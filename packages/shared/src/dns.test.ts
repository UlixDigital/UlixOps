// DNS rules (A156): record names relative to the zone, value validation per type, rollback
// planning (managed types only) and change descriptions.
import { describe, expect, it } from "vitest";
import {
  describeDiff,
  diffRecords,
  DnsRecordValue,
  type DnsRecord,
  fullRecordName,
  planRollback,
  recordsFingerprint,
  shortRecordName,
} from "./dns";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const rec = (
  id: number,
  type: string,
  name: string,
  content: string,
  extra: Partial<DnsRecord> = {},
): DnsRecord => ({
  id: hex(id),
  type,
  name,
  content,
  ttl: 1,
  proxied: false,
  priority: null,
  comment: null,
  ...extra,
});
const value = (over: Record<string, unknown>) =>
  DnsRecordValue.safeParse({
    type: "A",
    name: "www.shop.example",
    content: "1.2.3.4",
    ttl: 1,
    proxied: false,
    priority: null,
    comment: null,
    ...over,
  });

describe("record names", () => {
  it.each([
    ["@", "shop.example"],
    ["", "shop.example"],
    ["www", "www.shop.example"],
    ["WWW.Shop.Example", "www.shop.example"],
    ["mail.eu", "mail.eu.shop.example"],
    ["www.other.example", "www.other.example.shop.example"],
    ["www.shop.example.", "www.shop.example"],
    ["www.other.example.", null],
  ])("%j → %j", (input, expected) => {
    expect(fullRecordName(input, "shop.example")).toBe(expected);
  });

  it("shortens names for display", () => {
    expect(shortRecordName("shop.example", "shop.example")).toBe("@");
    expect(shortRecordName("www.shop.example", "shop.example")).toBe("www");
  });
});

describe("record values", () => {
  it("accepts good records of each managed type", () => {
    expect(value({}).success).toBe(true);
    expect(value({ type: "AAAA", content: "2001:db8::1" }).success).toBe(true);
    expect(value({ type: "CNAME", content: "wp.wpenginepowered.com", proxied: true }).success).toBe(
      true,
    );
    expect(value({ type: "MX", content: "mx.google.com", priority: 10 }).success).toBe(true);
    expect(value({ type: "TXT", content: '"v=spf1 include:_spf.google.com ~all"' }).success).toBe(
      true,
    );
    expect(value({ name: "*.shop.example" }).success).toBe(true);
    expect(value({ ttl: 3600 }).success).toBe(true);
  });

  it.each([
    [{ content: "1.2.3" }],
    [{ content: "1.2.3.4; rm -rf /" }],
    [{ type: "AAAA", content: "1.2.3.4" }],
    [{ type: "CNAME", content: "not a host" }],
    [{ type: "MX", content: "mx.google.com" }],
    [{ priority: 5 }],
    [{ type: "TXT", content: "line\nbreak" }],
    [{ type: "TXT", content: "x", proxied: true }],
    [{ type: "NS", content: "ns.example.com" }],
    [{ ttl: 30 }],
    [{ name: "bad name.shop.example" }],
  ])("refuses %j", (over) => {
    expect(value(over).success).toBe(false);
  });
});

describe("rollback planning", () => {
  const before = [
    rec(1, "A", "shop.example", "141.193.213.10", { proxied: true }),
    rec(2, "MX", "shop.example", "mx.mail.example", { priority: 10 }),
    rec(3, "NS", "dev.shop.example", "ns1.elsewhere.net"),
  ];

  it("plans nothing when the zone already matches", () => {
    expect(planRollback(before, before)).toEqual([]);
  });

  it("deletes added records, recreates removed ones and updates changed settings", () => {
    const now = [
      rec(1, "A", "shop.example", "141.193.213.10", { proxied: false }),
      rec(7, "A", "shop.example", "10.0.0.1"),
      rec(8, "NS", "x.shop.example", "ns.other.net"),
    ];
    const ops = planRollback(now, before);
    expect(ops).toEqual([
      { op: "delete", id: hex(7) },
      {
        op: "update",
        id: hex(1),
        record: expect.objectContaining({ type: "A", proxied: true }),
      },
      { op: "create", record: expect.objectContaining({ type: "MX", priority: 10 }) },
    ]);
    // NS records (not managed) are never touched either way.
    expect(ops.some((o) => o.op !== "create" && (o.id === hex(3) || o.id === hex(8)))).toBe(false);
  });

  it("describes and fingerprints differences", () => {
    const after = [...before.slice(1), rec(9, "TXT", "shop.example", "v=spf1 -all")];
    expect(describeDiff(diffRecords(before, after))).toEqual([
      "+ TXT shop.example → v=spf1 -all",
      "− A shop.example → 141.193.213.10",
    ]);
    expect(recordsFingerprint(before)).toBe(recordsFingerprint([...before].reverse()));
    expect(recordsFingerprint(before)).not.toBe(recordsFingerprint(after));
  });
});
