// IP allowlist matching (spec section 5: IP allowlisting). Server-side only: uses node:net, so it
// is a separate entry point (@ulixops/shared/ip) and never reaches browser bundles.
import { BlockList, isIP } from "node:net";

export interface Cidr {
  address: string;
  prefix: number;
  type: "ipv4" | "ipv6";
}

/** Strips the IPv4-mapped IPv6 prefix (::ffff:1.2.3.4) that Node often reports. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

/** "203.0.113.7", "203.0.113.0/24" or "2001:db8::/32"; a bare address means a single host. */
export function parseCidr(value: string): Cidr | null {
  const [rawAddress, rawPrefix, extra] = value.trim().split("/");
  if (!rawAddress || extra !== undefined) return null;
  const address = normalizeIp(rawAddress);
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  if (rawPrefix !== undefined && !/^\d{1,3}$/.test(rawPrefix)) return null;
  const prefix = rawPrefix === undefined ? max : Number(rawPrefix);
  if (prefix < 0 || prefix > max) return null;
  return { address, prefix, type: version === 4 ? "ipv4" : "ipv6" };
}

export function isValidCidr(value: string): boolean {
  return parseCidr(value) !== null;
}

/** True if `ip` falls inside any of `cidrs`. Invalid entries and addresses never match. */
export function ipInList(ip: string, cidrs: readonly string[]): boolean {
  const address = normalizeIp(ip);
  const version = isIP(address);
  if (version === 0) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed) list.addSubnet(parsed.address, parsed.prefix, parsed.type);
  }
  return list.check(address, version === 4 ? "ipv4" : "ipv6");
}

/** Comma- or space-separated list, as in the ALLOWED_IPS environment variable. */
export function parseIpList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && isValidCidr(entry));
}

/**
 * The allowlist decision used by the web proxy and the API. Enforcement is on when the Admin
 * list is enabled or ALLOWED_IPS is set; ALLOWED_IPS (server environment) is always allowed, as
 * the way back in if the list is ever wrong.
 */
export function allowlistPermits(
  ip: string | null,
  policy: { enabled: boolean; cidrs: readonly string[]; envCidrs: readonly string[] },
): boolean {
  const enforced = policy.enabled || policy.envCidrs.length > 0;
  if (!enforced) return true;
  if (!ip) return false;
  return ipInList(ip, policy.envCidrs) || (policy.enabled && ipInList(ip, policy.cidrs));
}
