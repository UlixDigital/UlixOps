import { SetupInspectResponse, Token } from "@ulixops/shared";
import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { apiPost } from "@/lib/api";
import { SetPasswordForm } from "../forms";

export const metadata: Metadata = { title: "Set up your account · UlixOps" };

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await searchParams;
  const valid = typeof token === "string" && Token.safeParse(token).success;
  const setup = valid
    ? await apiPost("/auth/setup/inspect", { setupToken: token }, SetupInspectResponse)
    : null;

  if (!valid || !setup?.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Setup link not valid</CardTitle>
        </CardHeader>
        <CardContent>
          <Notice tone="error">
            This link is invalid, has expired or was already used. Setup links work once, for 24
            hours. Ask an Admin for a new one.
          </Notice>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set your password</CardTitle>
        <CardDescription>
          For <span className="font-medium text-foreground">{setup.data.email}</span>. Next you'll
          set up two-factor authentication.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SetPasswordForm token={token} email={setup.data.email} />
      </CardContent>
    </Card>
  );
}
