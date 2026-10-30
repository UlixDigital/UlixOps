/**
 * The visitor's IP from request headers (agent decision A27). In production CLIENT_IP_HEADER is
 * cf-connecting-ip: Cloudflare overwrites it and the tunnel is the only way in, so it cannot be
 * faked. Without it (local dev) the first X-Forwarded-For hop is used, which a client CAN fake:
 * Next.js passes an incoming X-Forwarded-For through unchanged.
 */
export const TRUSTED_IP_HEADER = Boolean(process.env.CLIENT_IP_HEADER);

export function clientIpFrom(headers: Headers): string {
  const header = process.env.CLIENT_IP_HEADER;
  const raw = header ? headers.get(header) : headers.get("x-forwarded-for")?.split(",")[0];
  return raw?.trim().slice(0, 64) || "unknown";
}
