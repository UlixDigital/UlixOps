import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { readSession } from "@/lib/auth";
import { LoginForm } from "../forms";

export const metadata: Metadata = { title: "Sign in · UlixOps" };

const NOTICES = new Map([
  ["idle", "You were signed out after 30 minutes without activity. Sign in again."],
  ["expired", "Your session reached its 12-hour limit. Sign in again."],
  ["signed_out", "You've signed out."],
  ["challenge", "That sign-in attempt timed out. Start again."],
]);

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if ((await readSession()).status === "valid") redirect("/");
  const { reason } = await searchParams;
  const notice = typeof reason === "string" ? NOTICES.get(reason) : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>You'll also need the code from your authenticator app.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {notice && <Notice>{notice}</Notice>}
        <LoginForm />
      </CardContent>
    </Card>
  );
}
