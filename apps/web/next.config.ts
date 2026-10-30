import path from "node:path";
import type { NextConfig } from "next";

// Static security headers. The per-request nonce CSP is set in src/proxy.ts.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@ulixops/shared"],
  experimental: {
    // Plugin ZIPs up to MAX_PLUGIN_ZIP_BYTES (10 MB) pass through the proxy and a Server Action;
    // both default to smaller bodies (agent decision A62).
    serverActions: {
      bodySizeLimit: "11mb",
      // Cloudflare Tunnel sometimes omits/strips Origin; host still arrives as x-forwarded-host.
      allowedOrigins: ["ulixops.ulixdigital.com"],
    },
    proxyClientMaxBodySize: "11mb",
    // Don't keep a stale Sites list in the client router after sites are added (live QA).
    staleTimes: { dynamic: 0, static: 30 },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
