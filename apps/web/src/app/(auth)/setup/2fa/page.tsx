import { EnrollStartResponse } from "@ulixops/shared";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiPost } from "@/lib/api";
import { challengeToken } from "@/lib/auth";
import { EnrollForm } from "../../forms";

export const metadata: Metadata = { title: "Set up two-factor authentication · UlixOps" };

export default async function EnrollPage() {
  const token = await challengeToken();
  if (!token) redirect("/login?reason=challenge");
  const res = await apiPost(
    "/auth/2fa/enroll/start",
    { challengeToken: token },
    EnrollStartResponse,
  );
  if (!res.ok) redirect(res.error === "already_enrolled" ? "/login" : "/login?reason=challenge");

  // QR as an SVG data URL: no inline markup, and allowed by the CSP (img-src data:).
  const svg = await QRCode.toString(res.data.otpauthUri, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#09090b", light: "#ffffff" },
  });
  const qr = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const groupedSecret = res.data.secret.match(/.{1,4}/g)?.join(" ") ?? res.data.secret;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up two-factor authentication</CardTitle>
        <CardDescription>Required for every UlixOps account.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
          <li>Open an authenticator app (1Password, Google or Microsoft Authenticator…).</li>
          <li>Scan this QR code, or enter the key below.</li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL, nothing to optimise */}
        <img
          src={qr}
          alt="QR code that adds UlixOps to your authenticator app"
          width={176}
          height={176}
          className="mx-auto rounded-md border bg-white p-2"
        />
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Can't scan it?</summary>
          <p className="mt-2 text-muted-foreground">Enter this key in your app (time-based):</p>
          <code className="mt-1 block rounded-md bg-muted px-3 py-2 font-mono text-sm tracking-wider break-all">
            {groupedSecret}
          </code>
        </details>
        <EnrollForm />
      </CardContent>
    </Card>
  );
}
