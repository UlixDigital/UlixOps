import { describe, expect, it } from "vitest";
import { allowlistPermits, ipInList, normalizeIp, parseCidr, parseIpList } from "./ip";

describe("parseCidr", () => {
  it.each([
    ["203.0.113.7", { address: "203.0.113.7", prefix: 32, type: "ipv4" }],
    ["203.0.113.0/24", { address: "203.0.113.0", prefix: 24, type: "ipv4" }],
    ["2001:db8::/32", { address: "2001:db8::", prefix: 32, type: "ipv6" }],
    ["::ffff:10.0.0.1", { address: "10.0.0.1", prefix: 32, type: "ipv4" }],
  ])("parses %j", (input, expected) => {
    expect(parseCidr(input)).toEqual(expected);
  });

  it.each([
    "",
    "example.com",
    "300.1.1.1",
    "10.0.0.0/33",
    "2001:db8::/129",
    "10.0.0.0/8/1",
    "10.0.0.0/x",
    "10.0.0.0/-1",
  ])("rejects %j", (input) => {
    expect(parseCidr(input)).toBeNull();
  });
});

describe("ipInList", () => {
  const list = ["203.0.113.0/24", "198.51.100.7", "2001:db8:abcd::/48"];

  it("matches addresses inside ranges and single hosts", () => {
    expect(ipInList("203.0.113.200", list)).toBe(true);
    expect(ipInList("198.51.100.7", list)).toBe(true);
    expect(ipInList("2001:db8:abcd:1::5", list)).toBe(true);
    expect(ipInList("::ffff:203.0.113.9", list)).toBe(true);
  });

  it("refuses everything else, including junk", () => {
    expect(ipInList("203.0.114.1", list)).toBe(false);
    expect(ipInList("198.51.100.8", list)).toBe(false);
    expect(ipInList("2001:db8:abce::1", list)).toBe(false);
    expect(ipInList("unknown", list)).toBe(false);
    expect(ipInList("203.0.113.5", ["not-an-ip"])).toBe(false);
  });

  it("normalises IPv4-mapped IPv6 addresses", () => {
    expect(normalizeIp(" ::FFFF:172.18.0.1 ")).toBe("172.18.0.1");
  });
});

describe("allowlistPermits", () => {
  const office = ["203.0.113.0/24"];

  it("allows everyone when no list is in force", () => {
    expect(allowlistPermits("192.0.2.1", { enabled: false, cidrs: office, envCidrs: [] })).toBe(
      true,
    );
  });

  it("enforces the Admin list when enabled", () => {
    const policy = { enabled: true, cidrs: office, envCidrs: [] };
    expect(allowlistPermits("203.0.113.5", policy)).toBe(true);
    expect(allowlistPermits("192.0.2.1", policy)).toBe(false);
    expect(allowlistPermits(null, policy)).toBe(false);
  });

  it("always allows ALLOWED_IPS, and enforces it on its own", () => {
    const envOnly = { enabled: false, cidrs: office, envCidrs: ["192.0.2.1"] };
    expect(allowlistPermits("192.0.2.1", envOnly)).toBe(true);
    expect(allowlistPermits("203.0.113.5", envOnly)).toBe(false);
    expect(allowlistPermits("192.0.2.1", { ...envOnly, enabled: true })).toBe(true);
  });

  it("reads ALLOWED_IPS-style lists and drops invalid entries", () => {
    expect(parseIpList("203.0.113.0/24, 198.51.100.7  bogus\n2001:db8::/32")).toEqual([
      "203.0.113.0/24",
      "198.51.100.7",
      "2001:db8::/32",
    ]);
    expect(parseIpList(undefined)).toEqual([]);
  });
});
