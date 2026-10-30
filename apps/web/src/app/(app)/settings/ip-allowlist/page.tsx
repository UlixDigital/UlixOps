import { SettingsView } from "@ulixops/shared";
import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiGet } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { TRUSTED_IP_HEADER } from "@/lib/client-ip";
import { AllowlistForm } from "./allowlist-form";

export const metadata: Metadata = { title: "IP allowlist · UlixOps" };

export default async function IpAllowlistPage() {
  const res = await apiGet("/settings", SettingsView, await apiAuth());
  if (!res.ok) return <Notice tone="error">Settings couldn't be loaded. Refresh the page.</Notice>;
  const { ipAllowlist, envAllowedIps, currentIp } = res.data;
  const text = ipAllowlist.entries
    .map((e) => (e.label ? `${e.cidr}  ${e.label}` : e.cidr))
    .join("\n");

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">IP allowlist</CardTitle>
          <CardDescription>
            A second gate after Cloudflare Zero Trust: only office and VPN addresses reach UlixOps.
            Changes apply within 15 seconds and are recorded in the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!TRUSTED_IP_HEADER && (
            <Notice tone="error">
              This server reads visitor addresses from X-Forwarded-For, which a browser can fake.
              Fine for local testing; in production UlixOps reads Cloudflare's cf-connecting-ip
              header, which can't be faked.
            </Notice>
          )}
          <AllowlistForm enabled={ipAllowlist.enabled} entries={text} currentIp={currentIp} />
        </CardContent>
      </Card>

      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your address</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-sm">{currentIp ?? "unknown"}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              UlixOps won't save a list that leaves this address out, so you can't lock yourself
              out.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Always allowed</CardTitle>
            <CardDescription>
              Set on the server (<code className="font-mono text-xs">ALLOWED_IPS</code>), as the way
              back in if this list is ever wrong.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {envAllowedIps.length === 0 ? (
              <p className="text-sm text-muted-foreground">None set.</p>
            ) : (
              <ul className="grid gap-1 font-mono text-sm">
                {envAllowedIps.map((ip) => (
                  <li key={ip}>{ip}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
