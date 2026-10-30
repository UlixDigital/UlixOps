import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WebAuthnOptions } from "@ulixops/shared";
import { PasskeyLoginButton } from "@/components/passkey-buttons";
import { apiPost } from "@/lib/api";
import { challengeToken } from "@/lib/auth";
import { VerifyCodeForm } from "../../forms";

export const metadata: Metadata = { title: "Two-factor code · UlixOps" };

export default async function VerifyPage() {
  const token = await challengeToken();
  if (!token) redirect("/login?reason=challenge");
  const passkey = await apiPost(
    "/auth/login/passkey/options",
    { challengeToken: token },
    WebAuthnOptions,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Enter your code</CardTitle>
        <CardDescription>
          Open your authenticator app and enter the 6-digit code for UlixOps.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {passkey.ok && (
          <>
            <PasskeyLoginButton options={passkey.data} />
            <p className="text-center text-xs text-muted-foreground">or enter a code</p>
          </>
        )}
        <VerifyCodeForm />
      </CardContent>
    </Card>
  );
}
